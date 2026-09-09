(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MaterialBatchConfirmation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  function create(document) {
    var pending = null;
    function finish(approved) {
      if (!pending) return;
      var current = pending;
      pending = null;
      document.getElementById("confirmationPage").hidden = true;
      document.body.dataset.confirmation = "false";
      current.resolve(approved === true);
    }
    function request(message) {
      if (pending) return Promise.reject(new Error("已有确认等待处理，未重复操作"));
      var page = document.getElementById("confirmationPage");
      var copy = document.getElementById("confirmationText");
      var accept = document.getElementById("confirmationAccept");
      var cancel = document.getElementById("confirmationCancel");
      if (!page || !copy || !accept || !cancel) return Promise.reject(new Error("确认界面未加载，未继续操作"));
      copy.textContent = String(message || "");
      accept.onclick = function () { finish(true); };
      cancel.onclick = function () { finish(false); };
      page.hidden = false;
      document.body.dataset.confirmation = "true";
      if (typeof page.scrollTop === "number") page.scrollTop = 0;
      return new Promise(function (resolve) { pending = { resolve: resolve }; });
    }
    return { request: request, cancel: function () { finish(false); } };
  }
  return { create: create };
});
