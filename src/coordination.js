(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchCoordination = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createOperationQueue() {
    var tail = Promise.resolve();
    return {
      run: function (operation) {
        var release;
        var gate = new Promise(function (resolve) {
          release = resolve;
        });
        var previous = tail;
        tail = gate;
        return previous.then(operation, operation).finally(release);
      },
    };
  }

  function createGenerationGuard() {
    var generation = 0;
    return {
      bump: function () {
        generation += 1;
        return generation;
      },
      current: function () {
        return generation;
      },
      isCurrent: function (candidate) {
        return candidate === generation;
      },
    };
  }

  function shouldHandleOperationComplete(event, successState) {
    if (!event || event.state == null) return true;
    return successState != null && event.state === successState;
  }

  return {
    createGenerationGuard: createGenerationGuard,
    createOperationQueue: createOperationQueue,
    shouldHandleOperationComplete: shouldHandleOperationComplete,
  };
});
