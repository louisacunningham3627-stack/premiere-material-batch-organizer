using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// Derived from the voice-over helper's fail-closed protocol.  This helper has
// a separate scheme, bridge, and record domain for material-batch operations.
public static class MaterialFileHelper
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 33554432 };
    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    static long Now() { return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds; }
    static string ProgressPrefix;
    static bool CommitStarted;
    [StructLayout(LayoutKind.Sequential)] struct FileIdentity {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access; public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, out FileIdentity info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateDirectory(string path, IntPtr security);
    sealed class FileClaimException : IOException {
        public readonly int Win32Error;
        public readonly string Kind;
        public FileClaimException(int code) : base(code == 32 || code == 33
            ? "原素材暂时被占用，释放后自动继续"
            : code == 5 ? "原素材没有改名权限，原文件保留"
            : "无法取得原素材的改名权限，原文件保留（系统错误 " + code + "）") {
            Win32Error = code;
            Kind = code == 32 || code == 33 ? "busy" : code == 5 ? "permission" : "io";
        }
    }
    static FileStream OpenClaim(string path, Dictionary<string, object> request = null) {
        long deadline = Now() + 1200;
        while (true) {
            if (request != null) {
                Fresh(request);
                if (File.Exists(ProgressPrefix + ".cancel")) throw new OperationCanceledException("等待已取消，原文件保留");
            }
            AssertRegularFile(path);
            var handle = CreateFile(path, 0x80000000 | 0x00010000, 1, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (!handle.IsInvalid) return new FileStream(handle, FileAccess.Read);
            int code = Marshal.GetLastWin32Error();
            handle.Dispose();
            if (request == null || (code != 32 && code != 33) || Now() >= deadline) throw new FileClaimException(code);
            // 短等待只处理 Windows 共享冲突；长等待交回插件队列，不能占住其他素材。
            Thread.Sleep(150);
        }
    }
    static void RenameClaim(FileStream claim, string destination) {
        byte[] name = Encoding.Unicode.GetBytes(destination);
        int rootOffset = IntPtr.Size == 8 ? 8 : 4;
        int lengthOffset = rootOffset + IntPtr.Size;
        int nameOffset = lengthOffset + 4;
        int bufferSize = nameOffset + name.Length + 2;
        IntPtr data = Marshal.AllocHGlobal(bufferSize);
        try {
            for (int i = 0; i < bufferSize; i++) Marshal.WriteByte(data, i, 0);
            Marshal.WriteInt32(data, lengthOffset, name.Length);
            Marshal.Copy(name, 0, IntPtr.Add(data, nameOffset), name.Length);
            if (!SetFileInformationByHandle(claim.SafeFileHandle, 3, data, (uint)bufferSize))
                throw new IOException("原素材按句柄暂存或恢复失败，未覆盖目标，系统错误 " + Marshal.GetLastWin32Error());
        } finally { Marshal.FreeHGlobal(data); }
    }
    static string StagedPath(string source, string id) {
        return Path.Combine(Path.GetDirectoryName(source), ".premiere-material-recycle-" + id, Path.GetFileName(source));
    }
    static Microsoft.Win32.SafeHandles.SafeFileHandle GuardDirectory(string path) {
        var handle = CreateFile(path, 0x80000000 | 0x00010000, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (handle.IsInvalid && Marshal.GetLastWin32Error() == 5) {
            handle.Dispose();
            handle = CreateFile(path, 0x80000000, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        }
        if (handle.IsInvalid) { handle.Dispose(); throw new IOException("无法锁定事务暂存目录，原文件保留"); }
        return handle;
    }
    static void RemoveEmptyClaimedDirectory(Microsoft.Win32.SafeHandles.SafeFileHandle handle) {
        // 按本次创建目录的句柄清理；Windows 会拒绝非空目录，不解析新路径、不递归删除。
        IntPtr disposition = Marshal.AllocHGlobal(4);
        try {
            Marshal.WriteInt32(disposition, 1);
            SetFileInformationByHandle(handle, 4, disposition, 4);
        } finally { Marshal.FreeHGlobal(disposition); }
    }
    static void RestoreClaim(string staged, string original, Dictionary<string, object> fingerprint) {
        if (!File.Exists(staged) || File.Exists(original)) throw new IOException("暂存素材需要人工核对，未覆盖原路径：" + staged);
        using (var claim = OpenClaim(staged)) {
            VerifyFingerprint(staged, fingerprint);
            RenameClaim(claim, original);
        }
        VerifyInode(original, fingerprint);
    }
    public static void VerifyInode(string path, Dictionary<string, object> expected) {
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete)) {
            FileIdentity info;
            if (!GetFileInformationByHandle(file.SafeFileHandle, out info)) throw new IOException("无法读取文件系统身份");
            string inode = (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString();
            if (inode != Text(expected, "ino")) throw new IOException("文件系统身份已变化");
            if (info.Volume.ToString() != Text(expected, "dev")) throw new IOException("素材所在磁盘身份已变化");
        }
    }

    static string Text(Dictionary<string, object> value, string key)
    {
        object field;
        if (!value.TryGetValue(key, out field) || !(field is string) || String.IsNullOrEmpty((string)field))
            throw new InvalidDataException("素材回收字段缺失：" + key);
        return (string)field;
    }
    static double Number(Dictionary<string, object> value, string key)
    {
        object field;
        if (!value.TryGetValue(key, out field) || field == null || field is string)
            throw new InvalidDataException("素材回收数值缺失：" + key);
        double result = Convert.ToDouble(field);
        if (Double.IsNaN(result) || Double.IsInfinity(result)) throw new InvalidDataException("素材回收数值无效：" + key);
        return result;
    }
    static Dictionary<string, object> ObjectField(Dictionary<string, object> value, string key)
    {
        object field;
        var result = value.TryGetValue(key, out field) ? field as Dictionary<string, object> : null;
        if (result == null) throw new InvalidDataException("素材回收指纹缺失：" + key);
        return result;
    }
    public static void AssertPlainPath(string path)
    {
        if (!Regex.IsMatch(path ?? "", @"^[a-zA-Z]:\\") || path.IndexOf(':', 2) >= 0 || path.Contains("/"))
            throw new InvalidDataException("素材回收仅支持本地盘符绝对路径");
        if (!String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("素材回收拒绝非规范路径");
        string current = path;
        while (!String.IsNullOrEmpty(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("素材回收拒绝链接或挂载点");
            current = Path.GetDirectoryName(current);
        }
    }
    static void AssertRegularFile(string path)
    {
        AssertPlainPath(path);
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.Directory) != 0) throw new InvalidDataException("素材回收目标不是普通文件");
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("素材回收拒绝重解析文件");
        if (String.Equals(Path.GetExtension(path), ".prproj", StringComparison.OrdinalIgnoreCase)
            || String.Equals(Path.GetExtension(path), ".aep", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("素材回收拒绝工程文件");
        var drive = new DriveInfo(Path.GetPathRoot(path));
        if (drive.DriveType != DriveType.Fixed || !drive.IsReady) throw new InvalidDataException("素材回收仅支持本地固定磁盘");
    }
    static bool Same(string left, string right) { return String.Equals(left, right, StringComparison.OrdinalIgnoreCase); }
    static bool Inside(string root, string path)
    {
        string basePath = Path.GetFullPath(root).TrimEnd('\\') + "\\";
        string child = Path.GetFullPath(path);
        return child.StartsWith(basePath, StringComparison.OrdinalIgnoreCase) && !Same(child, root);
    }
    static Dictionary<string, object> Read(string path, int maxBytes = 262144)
    {
        AssertPlainPath(path);
        var info = new FileInfo(path);
        if (info.Length > maxBytes) throw new InvalidDataException("素材回收记录过大，原文件保留");
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    }
    static void VerifyRegistered(Dictionary<string, object> request, Dictionary<string, object> registered)
    {
        foreach (string field in new [] { "id", "path", "targetPath", "workspaceRoot", "statePath" })
            if (!Same(Text(request, field), Text(registered, field))) throw new InvalidDataException("登记请求字段不匹配：" + field);
        foreach (string name in new [] { "sourceFingerprint", "targetFingerprint" }) {
            var actual = ObjectField(request, name); var expected = ObjectField(registered, name);
            foreach (string field in new [] { "size", "mtimeMs", "birthtimeMs" })
                if (Number(actual, field) != Number(expected, field)) throw new InvalidDataException("登记文件指纹不匹配：" + field);
            foreach (string field in new [] { "sha256", "ino", "dev" })
                if (!String.Equals(Text(actual, field), Text(expected, field), StringComparison.Ordinal)) throw new InvalidDataException("登记文件身份不匹配：" + field);
        }
    }
    static string HashFile(string path)
    {
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete))
        using (var sha = SHA256.Create()) {
            byte[] buffer = new byte[1024 * 1024]; int count; long total = 0; long lastReport = 0;
            while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                if (!CommitStarted && ProgressPrefix != null && File.Exists(ProgressPrefix + ".cancel")) throw new OperationCanceledException("核验已取消，未提交回收");
                sha.TransformBlock(buffer, 0, count, buffer, 0); total += count;
                if (ProgressPrefix != null && Now() - lastReport > 250) {
                    lastReport = Now();
                    File.WriteAllText(ProgressPrefix + ".progress.json", Json.Serialize(new { path = path, checkedBytes = total, totalBytes = stream.Length }), new UTF8Encoding(false));
                }
            }
            sha.TransformFinalBlock(new byte[0], 0, 0);
            return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
        }
    }
    static string VerifyFingerprint(string path, Dictionary<string, object> expected)
    {
        AssertRegularFile(path);
        VerifyInode(path, expected);
        var info = new FileInfo(path);
        if (info.Length != Number(expected, "size")) throw new InvalidDataException("文件尺寸已变化");
        var expectedBirth = Number(expected, "birthtimeMs");
        var expectedWrite = Number(expected, "mtimeMs");
        var actualBirth = (info.CreationTimeUtc - Epoch).TotalMilliseconds;
        var actualWrite = (info.LastWriteTimeUtc - Epoch).TotalMilliseconds;
        if (Math.Abs(actualBirth - expectedBirth) > 2 || Math.Abs(actualWrite - expectedWrite) > 2)
            throw new InvalidDataException("文件时间身份已变化");
        var expectedHash = Text(expected, "sha256").ToLowerInvariant();
        if (!Regex.IsMatch(expectedHash, "^[0-9a-f]{64}$") || !Same(HashFile(path), expectedHash))
            throw new InvalidDataException("文件内容身份已变化");
        return expectedHash;
    }
    static void VerifyPair(string path, string targetPath, Dictionary<string, object> source, Dictionary<string, object> target)
    {
        var sourceHash = VerifyFingerprint(path, source);
        var targetHash = VerifyFingerprint(targetPath, target);
        if (!Same(sourceHash, targetHash)) throw new InvalidDataException("原素材与目标文件内容不一致");
    }
    static void Fresh(Dictionary<string, object> request)
    {
        var expiry = Number(request, "expiresAt");
        if (expiry < Now() || expiry > Now() + 21600000) throw new InvalidDataException("素材回收请求已过期");
    }
    static void WriteResult(string path, string id, string status, string filePath, string receiptId, string message, string token,
        int win32Error = 0, string failureKind = "")
    {
        var output = new Dictionary<string, object> {
            { "id", id }, { "status", status }, { "path", filePath }, { "receiptId", receiptId },
            { "message", message }, { "token", token }, { "checkedAt", Now() },
            { "win32Error", win32Error }, { "failureKind", failureKind }
        };
        PublishNewJson(path, output);
    }
    static void PublishNewJson(string path, object output)
    {
        var temp = path + ".tmp-" + Guid.NewGuid().ToString("N");
        using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) {
            writer.Write(Json.Serialize(output)); writer.Flush(); stream.Flush(true);
        }
        File.Move(temp, path);
    }
    static string Receipt(string deletedPath, string expectedHash, long expectedSize)
    {
        var shellType = Type.GetTypeFromProgID("Shell.Application");
        if (shellType == null) throw new IOException("无法访问系统回收站");
        object shell = Activator.CreateInstance(shellType);
        object bin = shellType.InvokeMember("Namespace", BindingFlags.InvokeMethod, null, shell, new object[] { 10 });
        if (bin == null) throw new IOException("无法打开系统回收站");
        object items = bin.GetType().InvokeMember("Items", BindingFlags.InvokeMethod, null, bin, null);
        int count = Convert.ToInt32(items.GetType().InvokeMember("Count", BindingFlags.GetProperty, null, items, null));
        string directory = Path.GetDirectoryName(deletedPath);
        string name = Path.GetFileName(deletedPath);
        var matches = new List<string>();
        for (int i = 0; i < count; i++)
        {
            object item = items.GetType().InvokeMember("Item", BindingFlags.InvokeMethod, null, items, new object[] { i });
            if (item == null) continue;
            string origin = Convert.ToString(item.GetType().InvokeMember("ExtendedProperty", BindingFlags.InvokeMethod, null, item, new object[] { "System.Recycle.DeletedFrom" }));
            string itemName = Convert.ToString(item.GetType().InvokeMember("Name", BindingFlags.GetProperty, null, item, null));
            string itemPath = Convert.ToString(item.GetType().InvokeMember("Path", BindingFlags.GetProperty, null, item, null));
            if (!Same(origin, directory) || !(Same(itemName, name) || Same(itemName, Path.GetFileNameWithoutExtension(name)))) continue;
            if (!File.Exists(itemPath) || new FileInfo(itemPath).Length != expectedSize || !Same(HashFile(itemPath), expectedHash)) continue;
            matches.Add(itemPath);
        }
        if (matches.Count != 1) throw new IOException("回收站中无法唯一核对原名、来源和内容");
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(matches[0] + "|" + expectedHash))).Replace("-", "").ToLowerInvariant();
    }

    [STAThread]
    public static int Main(string[] args)
    {
        string resultPath = null, id = null, token = null, targetPath = "", operationPath = "", stagedPath = "";
        Dictionary<string, object> restoreFingerprint = null;
        bool committed = false;
        try
        {
            if (args.Length == 1 && args[0] == "--serve") return MaterialBridgeService.Run();
            if (args.Length != 1 || !Regex.IsMatch(args[0] ?? "", "^hechao-material-recycle://(?:job|query|probe|reveal|identity)/[0-9a-f]{32}$")) return 2;
            bool reconcile = args[0].Contains("://query/");
            id = args[0].Substring(args[0].Length - 32);
            string helperDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            var location = Read(Path.Combine(helperDirectory, "bridge-location.json"));
            string bridge = Text(location, "directory");
            AssertPlainPath(bridge);
            string prefix = Path.Combine(bridge, id);
            if (args[0].Contains("://identity/")) {
                var request = Read(prefix + ".identity-request.json");
                string identityToken = Text(request, "token");
                if (!Regex.IsMatch(identityToken, "^[0-9a-f]{64}$") || identityToken != File.ReadAllText(Path.Combine(bridge, "token.txt")).Trim()
                    || Text(request, "id") != id || Number(request, "version") != 1) return 2;
                double expiry = Number(request, "expiresAt");
                if (expiry < Now() || expiry > Now() + 60000) return 2;
                string filePath = Text(request, "path");
                AssertRegularFile(filePath);
                using (var file = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    FileIdentity info;
                    if (!GetFileInformationByHandle(file.SafeFileHandle, out info)) return 2;
                    var metadata = new FileInfo(filePath);
                    PublishNewJson(prefix + ".identity-result.json", new { id = id, token = identityToken, path = filePath, status = "identified",
                            size = file.Length, mtimeMs = (long)(metadata.LastWriteTimeUtc - Epoch).TotalMilliseconds,
                            birthtimeMs = (long)(metadata.CreationTimeUtc - Epoch).TotalMilliseconds,
                            dev = info.Volume.ToString(), ino = (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString() });
                }
                return 0;
            }
            if (args[0].Contains("://reveal/")) {
                var reveal = Read(prefix + ".reveal-request.json");
                string revealToken = Text(reveal, "token");
                if (!Regex.IsMatch(revealToken, "^[0-9a-f]{64}$")
                    || revealToken != File.ReadAllText(Path.Combine(bridge, "token.txt")).Trim()
                    || Text(reveal, "id") != id || Number(reveal, "version") != 1) return 2;
                double expiry = Number(reveal, "expiresAt");
                if (expiry < Now() || expiry > Now() + 60000) return 2;
                string directory = Text(reveal, "directory");
                AssertPlainPath(directory);
                if (!Directory.Exists(directory) || directory.Contains("\"")) return 2;
                using (var claim = new FileStream(prefix + ".reveal-claim", FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {
                        FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"),
                        Arguments = "\"" + directory.TrimEnd('\\') + "\\.\"", UseShellExecute = false
                    });
                    PublishNewJson(prefix + ".reveal-result.json", new { id = id, token = revealToken, version = 1, status = "opened" });
                }
                return 0;
            }
            if (args[0].Contains("://probe/")) {
                var probe = Read(prefix + ".probe-request.json");
                string probeToken = Text(probe, "token");
                if (!Regex.IsMatch(probeToken, "^[0-9a-f]{64}$")
                    || probeToken != File.ReadAllText(Path.Combine(bridge, "token.txt")).Trim()
                    || Text(probe, "id") != id || Number(probe, "version") != 1) return 2;
                double expiry = Number(probe, "expiresAt");
                if (expiry < Now() || expiry > Now() + 60000) return 2;
                PublishNewJson(prefix + ".probe-result.json", new { id = id, token = probeToken, version = 1, status = "available" });
                return 0;
            }
            ProgressPrefix = prefix;
            using (var claim = new FileStream(prefix + ".lock", FileMode.OpenOrCreate, FileAccess.Write, FileShare.None))
            {
                var request = Read(prefix + ".request.json");
                token = Text(request, "token").ToLowerInvariant();
                string installedToken = File.ReadAllText(Path.Combine(bridge, "token.txt")).Trim();
                if (token != installedToken) throw new InvalidDataException("安装凭据不匹配");
                if (!Regex.IsMatch(token, "^[0-9a-f]{64}$") || Number(request, "version") != 1 || !Same(Text(request, "id"), id))
                    throw new InvalidDataException("素材回收助手身份验证失败");
                resultPath = prefix + (reconcile ? ".reconciled.json" : ".result.json");
                if (File.Exists(resultPath)) {
                    if (!reconcile || Text(Read(resultPath), "status") != "uncertain") return 0;
                    File.Move(resultPath, prefix + ".reconciled-previous-" + Guid.NewGuid().ToString("N") + ".json");
                }
                if (!reconcile) {
                    if (File.Exists(prefix + ".ready.json") || File.Exists(prefix + ".commit.json")) throw new InvalidDataException("旧请求只允许核对，不重复执行回收");
                    Fresh(request);
                }
                string path = Text(request, "path"); operationPath = path; targetPath = Text(request, "targetPath");
                string workspace = Text(request, "workspaceRoot"); string statePath = Text(request, "statePath");
                string issuedPath = statePath + ".recycle-" + id + ".issued";
                if (!reconcile) AssertRegularFile(path);
                AssertRegularFile(targetPath); AssertPlainPath(workspace); AssertPlainPath(statePath);
                if (!Directory.Exists(workspace) || !Inside(workspace, targetPath) || !File.Exists(statePath))
                    throw new InvalidDataException("素材回收工程边界或事务凭据无效");
                if (!Same(statePath, Path.Combine(workspace, ".premiere-material-space.json"))) throw new InvalidDataException("事务记录路径不匹配");
                var pending = ObjectField(Read(statePath, 33554432), "pendingTransaction");
                var registered = ObjectField(pending, "recycleRequest");
                VerifyRegistered(request, registered);
                if (!Same(Text(registered, "id"), id) || !Same(Text(registered, "path"), path)
                    || !Same(Text(registered, "targetPath"), targetPath)
                    || !Same(Path.GetFullPath(Path.Combine(workspace, Text(pending, "targetRelativePath"))), targetPath))
                    throw new InvalidDataException("请求不属于当前已登记的搬运事务");
                object cleanup;
                if (!Same(Text(pending, "sourcePath"), path)
                    && !(pending.TryGetValue("cleanupPath", out cleanup) && Same(Convert.ToString(cleanup), path)))
                    throw new InvalidDataException("回收路径不属于当前事务");
                var sourceFingerprint = ObjectField(request, "sourceFingerprint");
                restoreFingerprint = sourceFingerprint;
                var targetFingerprint = ObjectField(request, "targetFingerprint");
                if (reconcile) {
                    CommitStarted = true;
                    committed = true;
                    stagedPath = StagedPath(path, id);
                    VerifyFingerprint(targetPath, targetFingerprint);
                    if (File.Exists(stagedPath)) {
                        var journal = Read(prefix + ".staged.json");
                        if (!Same(Text(journal, "id"), id) || !Same(Text(journal, "message"), stagedPath) || Text(journal, "token") != token)
                            throw new InvalidDataException("暂存恢复凭据不匹配，保留现场");
                        RestoreClaim(stagedPath, path, sourceFingerprint);
                        WriteResult(resultPath, id, "failed", path, "", "已核验并恢复原位置，可重新发起回收", token);
                        return 0;
                    }
                    if (File.Exists(path)) {
                        VerifyFingerprint(path, sourceFingerprint);
                        WriteResult(resultPath, id, "failed", path, "", "已核验原素材仍在原位置，未重复回收", token);
                        return 0;
                    }
                    var stagedJournal = Read(prefix + ".staged.json");
                    if (!Same(Text(stagedJournal, "id"), id) || !Same(Text(stagedJournal, "message"), stagedPath)
                        || Text(stagedJournal, "token") != token || !Same(Text(stagedJournal, "path"), path))
                        throw new InvalidDataException("缺少本次事务的暂存凭据，不能引用历史回收站文件");
                    string foundReceipt = Receipt(stagedPath, Text(sourceFingerprint, "sha256"), (long)Number(sourceFingerprint, "size"));
                    WriteResult(resultPath, id, "recycled", path, foundReceipt, "已从系统回收站核对结果，未再次回收", token);
                    return 0;
                }
                using (var sourceGuard = OpenClaim(path, request))
                using (var targetGuard = new FileStream(targetPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete)) {
                VerifyPair(path, targetPath, sourceFingerprint, targetFingerprint);
                resultPath = prefix + ".result.json";
                WriteResult(prefix + ".ready.json", id, "ready", path, "", "", token);
                while (!File.Exists(prefix + ".commit.json")) { Fresh(request); if (File.Exists(prefix + ".cancel")) throw new OperationCanceledException("核验已取消"); Thread.Sleep(100); }
                var commit = Read(prefix + ".commit.json");
                if (!Same(Text(commit, "id"), id) || !Same(Text(commit, "token"), token)
                    || !Same(Text(commit, "statePath"), statePath) || !Same(Text(commit, "issuedPath"), issuedPath)
                    || Math.Abs(Now() - Number(commit, "at")) > 1500 || !File.Exists(issuedPath))
                    throw new InvalidDataException("素材回收最终事务凭据无效");
                Fresh(request);
                var issued = Read(issuedPath);
                if (!Same(Text(issued, "id"), id) || !Same(Text(issued, "transactionId"), Text(pending, "id")))
                    throw new InvalidDataException("回收提交凭据与搬运事务不匹配");
                var committedPending = ObjectField(Read(statePath, 33554432), "pendingTransaction");
                if (!Same(Text(committedPending, "id"), Text(pending, "id"))) throw new InvalidDataException("提交时搬运事务已变化");
                VerifyRegistered(request, ObjectField(committedPending, "recycleRequest"));
                if (!Same(Text(ObjectField(committedPending, "recycleRequest"), "id"), id)) throw new InvalidDataException("提交时事务已变化");
                // 内容已在 ready 前完整核验，两个只读句柄持续阻止写入。
                // 提交后只复核路径身份，避免大文件二次哈希使宿主凭据过期。
                VerifyInode(path, sourceFingerprint);
                VerifyInode(targetPath, targetFingerprint);
                Fresh(request);
                if (Math.Abs(Now() - Number(commit, "at")) > 1500 || File.Exists(prefix + ".cancel"))
                    throw new InvalidDataException("回收提交已过期或取消，原文件保留");
                committed = true;
                CommitStarted = true;
                stagedPath = StagedPath(path, id);
                string stagedDirectory = Path.GetDirectoryName(stagedPath);
                if (!CreateDirectory(stagedDirectory, IntPtr.Zero)) throw new IOException("事务暂存目录已存在或不可创建，原素材保留");
                AssertPlainPath(stagedDirectory);
                using (var directoryGuard = GuardDirectory(stagedDirectory)) {
                WriteResult(prefix + ".staged.json", id, "staging-prepared", path, "", stagedPath, token);
                RenameClaim(sourceGuard, stagedPath);
                VerifyInode(stagedPath, sourceFingerprint);
#if MATERIAL_HELPER_TEST
                if (Environment.GetEnvironmentVariable("MATERIAL_TEST_KEEP_STAGE_FILE") == "1")
                    File.WriteAllText(Path.Combine(stagedDirectory, "independent-preserved.txt"), "preserved-test-file");
                if (Environment.GetEnvironmentVariable("MATERIAL_TEST_PAUSE_AFTER_STAGE") == "1") {
                    WriteResult(prefix + ".test-staged.json", id, "test-paused", path, "", stagedPath, token);
                    Thread.Sleep(30000);
                }
                if (Environment.GetEnvironmentVariable("MATERIAL_TEST_FAIL_RECYCLE") == "1") throw new IOException("测试注入：回收前失败");
#endif
                using (var stagedGuard = new FileStream(stagedPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete)) {
                sourceGuard.Dispose();
                MaterialRecycleNative.RecycleOnly(stagedPath, delegate { VerifyInode(stagedPath, sourceFingerprint); });
                if (File.Exists(stagedPath)) throw new IOException("系统未确认暂存原素材已进入回收站");
                string receipt = Receipt(stagedPath, Text(sourceFingerprint, "sha256"), (long)Number(sourceFingerprint, "size"));
                WriteResult(resultPath, id, "recycled", path, receipt, "", token);
                }
                RemoveEmptyClaimedDirectory(directoryGuard);
                return 0;
                }
                }
            }
        }
        catch (Exception error)
        {
            string message = error.Message;
            if (committed && restoreFingerprint != null) {
                try {
                    if (!String.IsNullOrEmpty(stagedPath) && File.Exists(stagedPath)) RestoreClaim(stagedPath, operationPath, restoreFingerprint);
                    if (File.Exists(operationPath)) {
                        VerifyFingerprint(operationPath, restoreFingerprint);
                        committed = false;
                    }
                } catch (Exception restoreError) { message += "；" + restoreError.Message; }
            }
            if (resultPath != null)
            {
                var claimError = error as FileClaimException;
                try { WriteResult(resultPath, id, committed ? "uncertain" : "failed", operationPath, "", message, token,
                    claimError == null ? 0 : claimError.Win32Error, claimError == null ? "" : claimError.Kind); } catch { }
            }
            return 1;
        }
    }
}

public static class MaterialRecycleNative
{
    [StructLayout(LayoutKind.Sequential)] struct BinInfo { public uint Size; public long Bytes; public long Items; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHQueryRecycleBin(string root, ref BinInfo info);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IShellItem {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr output);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint format, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }
    [ComVisible(true), Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IProgressSink {
        [PreserveSig] int StartOperations(); [PreserveSig] int FinishOperations(int result);
        [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
        [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
        [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, int result, IShellItem created);
        [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
        [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int result, IShellItem created);
        [PreserveSig] int PreNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int PostNewItem(uint flags, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, uint attributes, int result, IShellItem created);
        [PreserveSig] int UpdateProgress(uint total, uint complete);
        [PreserveSig] int ResetTimer(); [PreserveSig] int PauseTimer(); [PreserveSig] int ResumeTimer();
    }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class RecycleSink : IProgressSink {
        readonly string expectedPath; readonly Action verify;
        public bool Confirmed;
        public RecycleSink(string path, Action check) { expectedPath = path; verify = check; }
        public int PreDeleteItem(uint flags, IShellItem item) {
            try {
                if ((flags & 0x80) == 0) return unchecked((int)0x80004004);
                IntPtr name; item.GetDisplayName(0x80058000, out name);
                try { if (!String.Equals(Marshal.PtrToStringUni(name), expectedPath, StringComparison.OrdinalIgnoreCase)) return unchecked((int)0x80004004); }
                finally { Marshal.FreeCoTaskMem(name); }
                MaterialFileHelper.AssertPlainPath(expectedPath); verify(); Confirmed = true; return 0;
            } catch { return unchecked((int)0x80004004); }
        }
        public int StartOperations() { return 0; } public int FinishOperations(int result) { return 0; }
        public int PreRenameItem(uint f, IShellItem i, string n) { return unchecked((int)0x80004004); }
        public int PostRenameItem(uint f, IShellItem i, string n, int r, IShellItem c) { return 0; }
        public int PreMoveItem(uint f, IShellItem i, IShellItem d, string n) { return unchecked((int)0x80004004); }
        public int PostMoveItem(uint f, IShellItem i, IShellItem d, string n, int r, IShellItem c) { return 0; }
        public int PreCopyItem(uint f, IShellItem i, IShellItem d, string n) { return unchecked((int)0x80004004); }
        public int PostCopyItem(uint f, IShellItem i, IShellItem d, string n, int r, IShellItem c) { return 0; }
        public int PostDeleteItem(uint f, IShellItem i, int r, IShellItem c) { return 0; }
        public int PreNewItem(uint f, IShellItem d, string n) { return unchecked((int)0x80004004); }
        public int PostNewItem(uint f, IShellItem d, string n, string t, uint a, int r, IShellItem c) { return 0; }
        public int UpdateProgress(uint t, uint c) { return 0; } public int ResetTimer() { return 0; }
        public int PauseTimer() { return 0; } public int ResumeTimer() { return 0; }
    }
    [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOperation
    {
        void Advise(IntPtr sink, out uint cookie); void Unadvise(uint cookie); void SetOperationFlags(uint flags);
        void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string text); void SetProgressDialog(IntPtr dialog);
        void SetProperties(IntPtr properties); void SetOwnerWindow(uint owner); void ApplyPropertiesToItem(IShellItem item);
        void ApplyPropertiesToItems(IntPtr items); void RenameItem(IShellItem item, string name, IntPtr sink);
        void RenameItems(IntPtr items, string name); void MoveItem(IShellItem item, IShellItem folder, string name, IntPtr sink);
        void MoveItems(IShellItem items, IShellItem folder); void CopyItem(IShellItem item, IShellItem folder, string name, IntPtr sink);
        void CopyItems(IShellItem items, IShellItem folder); void DeleteItem(IShellItem item, IntPtr sink); void DeleteItems(IntPtr items);
        void NewItem(IShellItem folder, uint attributes, string name, string template, IntPtr sink);
        [PreserveSig] int PerformOperations(); [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }
    public static void RecycleOnly(string path, Action verify)
    {
        var bin = new BinInfo { Size = (uint)Marshal.SizeOf(typeof(BinInfo)) };
        if (SHQueryRecycleBin(Path.GetPathRoot(path), ref bin) != 0) throw new IOException("无法确认回收站可用");
        var operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
        IShellItem item = null;
        IntPtr sinkPointer = IntPtr.Zero;
        try
        {
            // RECYCLEONDELETE is mandatory; no File.Delete fallback is permitted.
            operation.SetOperationFlags(0x00080000 | 0x00100000 | 0x00000400 | 0x00000004 | 0x00000010 | 0x00004000);
            var iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
            var sink = new RecycleSink(path, verify);
            sinkPointer = Marshal.GetComInterfaceForObject(sink, typeof(IProgressSink));
            operation.DeleteItem(item, sinkPointer);
            int result = operation.PerformOperations(); bool aborted;
            int abortResult = operation.GetAnyOperationsAborted(out aborted);
            if (result != 0 || abortResult != 0 || aborted || !sink.Confirmed) throw new IOException("系统取消或拒绝了安全回收");
        }
        finally
        {
            if (item != null) Marshal.ReleaseComObject(item);
            if (sinkPointer != IntPtr.Zero) Marshal.Release(sinkPointer);
            Marshal.ReleaseComObject(operation);
        }
    }
}
