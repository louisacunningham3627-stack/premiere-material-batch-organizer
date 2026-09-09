using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

// Per-user, local-file transport. Child jobs retain the native transaction checks.
public static class MaterialBridgeService
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    static long Now() { return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds; }
    static Dictionary<string, object> Read(string path) {
        MaterialFileHelper.AssertPlainPath(path);
        if (new FileInfo(path).Length > 8192) throw new IOException("Local request too large");
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
    }
    static string Text(Dictionary<string, object> value, string key) {
        object field; return value.TryGetValue(key, out field) && field is string ? (string)field : "";
    }
    static void Write(string path, object value, bool replace = false) {
        string temporary = path + ".writing-" + Guid.NewGuid().ToString("N");
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (var writer = new StreamWriter(file, new UTF8Encoding(false))) { writer.Write(Json.Serialize(value)); writer.Flush(); file.Flush(true); }
        if (replace && File.Exists(path)) { MaterialFileHelper.AssertPlainPath(path); File.Replace(temporary, path, null); }
        else File.Move(temporary, path);
    }
    public static int Run() {
        string executable = Assembly.GetExecutingAssembly().Location;
        string bridge = Text(Read(Path.Combine(Path.GetDirectoryName(executable), "bridge-location.json")), "directory");
        MaterialFileHelper.AssertPlainPath(bridge);
        string tokenPath = Path.Combine(bridge, "token.txt");
        MaterialFileHelper.AssertPlainPath(tokenPath);
        string token = File.ReadAllText(tokenPath).Trim();
        if (!Regex.IsMatch(token, "^[0-9a-f]{64}$")) return 2;
        string mutexId;
        using (var sha = SHA256.Create()) mutexId = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(bridge.ToLowerInvariant()))).Replace("-", "");
        bool created;
        using (var mutex = new Mutex(true, "Local\\HechaoMaterial-" + mutexId, out created)) {
            if (!created) return 0;
            string session = Guid.NewGuid().ToString("N");
            string sessionFile = Path.Combine(bridge, "service-" + session + ".json");
            var identity = new { session = session, token = token, pid = Process.GetCurrentProcess().Id, executable = executable,
                startedAt = (long)(Process.GetCurrentProcess().StartTime.ToUniversalTime() - Epoch).TotalMilliseconds, version = 1 };
            Write(sessionFile, identity);
            Write(Path.Combine(bridge, "service.current.json"), identity, true);
            var children = new Dictionary<string, Process>();
            bool stopping = false;
            try {
                while (true) {
                    foreach (string key in new List<string>(children.Keys)) {
                        if (children[key].HasExited) { children[key].Dispose(); children.Remove(key); }
                    }
                    string stopFile = Path.Combine(bridge, "service-" + session + ".stop.json");
                    if (File.Exists(stopFile)) {
                        try { var stop = Read(stopFile); stopping = Text(stop, "token") == token && Text(stop, "session") == session; } catch { }
                    }
                    if (stopping && children.Count == 0) {
                        Write(Path.Combine(bridge, "service-" + session + ".stopped.json"), new { session = session, token = token, status = "stopped" });
                        return 0;
                    }
                    if (!stopping && children.Count < 4) {
                        foreach (string file in Directory.EnumerateFiles(bridge, "*.dispatch.json", SearchOption.TopDirectoryOnly)) {
                            if (children.Count >= 4) break;
                            string ticket = Path.GetFileName(file).Replace(".dispatch.json", "");
                            if (!Regex.IsMatch(ticket, "^[0-9a-f]{32}$")) continue;
                            string accepted = Path.Combine(bridge, ticket + ".accepted.json");
                            string response = Path.Combine(bridge, ticket + ".dispatch-result.json");
                            if (File.Exists(accepted)) continue;
                            try {
                                var request = Read(file);
                                string id = Text(request, "id"), verb = Text(request, "verb");
                                if (Text(request, "token") != token || Text(request, "ticket") != ticket || Text(request, "session") != session
                                    || !Regex.IsMatch(id, "^[0-9a-f]{32}$") || !Regex.IsMatch(verb, "^(job|query|probe|identity|reveal)$")) continue;
                                double expiry = Convert.ToDouble(request["expiresAt"]);
                                if (Double.IsNaN(expiry) || Double.IsInfinity(expiry) || expiry < Now() || expiry > Now() + 60000) continue;
                                if (children.ContainsKey(id)) continue;
                                // Claim before launch so a crashed service cannot replay a job automatically.
                                Write(accepted, new { ticket = ticket, session = session });
                                var child = Process.Start(new ProcessStartInfo { FileName = executable,
                                    Arguments = "hechao-material-recycle://" + verb + "/" + id,
                                    UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
                                children.Add(id, child);
                                Write(response, new { ticket = ticket, id = id, token = token, session = session, verb = verb, status = "dispatched" });
                            } catch {
                                // Malformed/partially written records never authorize work; callers time out safely.
                            }
                        }
                    }
                    Thread.Sleep(150);
                }
            } finally { mutex.ReleaseMutex(); }
        }
    }
}
