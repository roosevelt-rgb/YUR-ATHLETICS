"use strict";

// Main-process cadence and transport for deployed agent lifecycles. Committed
// deployment claims supply the exact Work request; the Python OrchestrationManager
// owns every execution. When the headless lifecycle runner holds its journal lock,
// this dispatcher defers so a deployment is never driven by two hosts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MISSION = /^[0-9a-f]{32}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STATUSES = new Set([
  "queued",
  "running",
  "awaiting_approval",
  ...TERMINAL,
]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const failure = (error) => ({
  code: String(error?.code || "LIFECYCLE_DISPATCH_FAILED").slice(0, 80),
  message: String(
    error?.message || error || "Lifecycle dispatch failed.",
  ).slice(0, 2000),
});

function createLifecycleDispatcher({
  workTransport,
  onState = () => {},
  intervalMs = 10000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
} = {}) {
  if (
    !workTransport ||
    ["start", "request", "cancel"].some(
      (method) => typeof workTransport[method] !== "function",
    ) ||
    typeof onState !== "function" ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs > 60000
  )
    throw new Error(
      "Lifecycle dispatcher requires the existing Work transport and bounded cadence.",
    );
  const owner = Object.freeze({ kind: "committed-lifecycle-dispatcher" });
  let timer = null,
    flight = null,
    active = null;
  const current = {
    enabled: false,
    running: false,
    phase: "stopped",
    delegated: false,
    active_deployment_id: null,
    request_id: null,
    mission_id: null,
    next_tick_at: null,
    last_result: null,
    error: null,
  };
  const status = () => JSON.parse(JSON.stringify(current));
  const publish = () => {
    try {
      onState(status());
    } catch {
      /* observers cannot change committed dispatch */
    }
  };
  function update(fields) {
    Object.assign(current, fields);
    publish();
  }
  function clearTick() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    current.next_tick_at = null;
  }
  function nextTick() {
    if (!current.enabled || timer !== null) return;
    current.next_tick_at = new Date(now() + intervalMs).toISOString();
    timer = setTimer(() => {
      timer = null;
      current.next_tick_at = null;
      void wake();
    }, intervalMs);
    timer?.unref?.();
    publish();
  }
  async function rpc(request) {
    const response = await workTransport.request(request);
    if (response?.ok !== true || !object(response.result)) {
      const error = new Error(
        response?.error?.message ||
          "Lifecycle runtime returned an invalid result.",
      );
      error.code = response?.error?.code || "INVALID_LIFECYCLE_RESPONSE";
      throw error;
    }
    return response.result;
  }
  function claimChecked(value) {
    if (
      !object(value) ||
      !object(value.deployment) ||
      !object(value.request) ||
      typeof value.replayed !== "boolean" ||
      !UUID.test(value.deployment.id) ||
      !UUID.test(value.request.request_id) ||
      value.deployment.active_request_id !== value.request.request_id ||
      value.deployment.conversation_id !== value.request.conversation_id
    )
      throw new Error("Lifecycle runtime returned an invalid claim identity.");
    return value;
  }
  function missionChecked(value, claim, allowNull = false) {
    if (allowNull && value === null) return null;
    if (
      !object(value) ||
      !MISSION.test(value.id) ||
      !STATUSES.has(value.status) ||
      value.request_id !== claim.request.request_id ||
      value.conversation_id !== claim.request.conversation_id
    )
      throw new Error("Lifecycle mission does not match the committed claim.");
    return value;
  }
  const resolve = async (claim) =>
    missionChecked(
      (
        await rpc({
          command: "lifecycle_resolve",
          request_id: claim.request.request_id,
        })
      ).mission,
      claim,
      true,
    );
  async function complete(claim, mission) {
    if (!TERMINAL.has(mission.status))
      throw new Error(
        "Only actual terminal Work can complete a deployment run.",
      );
    update({ phase: "reconciling", mission_id: mission.id });
    const result = await rpc({
      command: "lifecycle_complete",
      deployment_id: claim.deployment.id,
      mission_id: mission.id,
    });
    if (
      result.deployment?.id !== claim.deployment.id ||
      result.mission_status !== mission.status
    )
      throw new Error("Lifecycle completion returned an invalid receipt.");
    update({
      phase: "idle",
      error: null,
      last_result: {
        deployment_id: claim.deployment.id,
        mission_id: mission.id,
        mission_status: result.mission_status,
        state: result.deployment.state,
        replayed: result.replayed,
      },
    });
    return result;
  }
  async function cancel(requestId) {
    const operation = active;
    if (!operation || operation.claim.request.request_id !== requestId)
      return { ok: true, result: { cancelled: false } };
    operation.cancelRequested = true;
    if (operation.cancelPromise) return operation.cancelPromise;
    operation.cancelPromise = (async () => {
      let result, error, local;
      try {
        result = await rpc({
          command: "lifecycle_cancel_request",
          deployment_id: operation.claim.deployment.id,
          request_id: requestId,
        });
        missionChecked(result.mission, operation.claim);
      } catch (value) {
        error = value;
      }
      try {
        local = await workTransport.cancel(requestId, owner);
      } catch (value) {
        error ||= value;
      }
      if (!result?.mission && local?.ok && local.result?.mission) {
        try {
          result = {
            mission: missionChecked(local.result.mission, operation.claim),
          };
          error = null;
        } catch (value) {
          error = value;
        }
      }
      if (error || !result?.mission) {
        const detail = failure(
          error ||
            local?.error ||
            new Error("Lifecycle cancellation was not confirmed."),
        );
        update({ error: detail, phase: "error" });
        return { ok: false, error: detail };
      }
      return {
        ok: true,
        result: {
          cancelled: result.mission.status === "cancelled",
          mission: result.mission,
        },
      };
    })();
    return operation.cancelPromise;
  }
  async function dispatch(claim) {
    const operation = { claim, cancelRequested: false, cancelPromise: null };
    active = operation;
    update({
      phase: "resolving",
      active_deployment_id: claim.deployment.id,
      request_id: claim.request.request_id,
      mission_id: null,
    });
    try {
      let mission = await resolve(claim);
      if (mission && TERMINAL.has(mission.status)) {
        await complete(claim, mission);
        return;
      }
      if (claim.deployment.state !== "active" && !mission) {
        // Paused mid-claim before Work existed: record honestly, never fabricate a run.
        await rpc({
          command: "lifecycle_dispatch_error",
          deployment_id: claim.deployment.id,
          request_id: claim.request.request_id,
          error: "Deployment was paused before its claimed run started.",
        });
        update({ phase: "idle" });
        return;
      }
      if (mission?.status === "awaiting_approval") {
        update({ phase: "awaiting_review", mission_id: mission.id });
        return;
      }
      update({
        phase: "running",
        mission_id: mission?.id || null,
        error: null,
      });
      let response;
      try {
        response = await workTransport.start(claim.request, owner);
      } catch (error) {
        response = { ok: false, error: failure(error) };
      }
      if (operation.cancelPromise) await operation.cancelPromise;
      mission = await resolve(claim);
      if (mission && TERMINAL.has(mission.status))
        await complete(claim, mission);
      else if (mission?.status === "awaiting_approval")
        update({ phase: "awaiting_review", mission_id: mission.id });
      else if (mission)
        update({
          phase: response?.ok ? "running" : "error",
          mission_id: mission.id,
          error: response?.ok ? null : failure(response?.error),
        });
      else if (
        !response?.ok &&
        ["BUSY", "WORKER_BUSY"].includes(response?.error?.code)
      )
        update({ phase: "waiting", error: failure(response.error) });
      else if (!response?.ok) {
        const error = failure(response?.error);
        await rpc({
          command: "lifecycle_dispatch_error",
          deployment_id: claim.deployment.id,
          request_id: claim.request.request_id,
          error: error.message,
        });
        update({ phase: "error", error });
      } else
        throw new Error(
          "Work accepted the deployment run but its committed mission could not be resolved.",
        );
    } finally {
      if (active === operation) active = null;
      update({ active_deployment_id: null, request_id: null });
    }
  }
  function wake() {
    if (!current.enabled) return Promise.resolve(status());
    if (flight) return flight;
    clearTick();
    update({ running: true, phase: "claiming" });
    flight = (async () => {
      try {
        const result = await rpc({ command: "lifecycle_claim" });
        if (result.delegated === true) {
          update({ delegated: true, phase: "delegated", error: null });
          return status();
        }
        if (current.delegated) update({ delegated: false });
        if (!Array.isArray(result.claims) || result.claims.length > 20)
          throw new Error(
            "Lifecycle claim response exceeds its bounded batch.",
          );
        const claims = result.claims.map(claimChecked);
        if (!claims.length) update({ phase: "idle" });
        for (const claim of claims) {
          if (!current.enabled) break;
          try {
            await dispatch(claim);
          } catch (error) {
            update({
              phase: "error",
              error: {
                ...failure(error),
                deployment_id: claim.deployment.id,
                request_id: claim.request.request_id,
              },
            });
          }
        }
      } catch (error) {
        update({ phase: "error", error: failure(error) });
      } finally {
        flight = null;
        current.running = false;
        if (!current.enabled) current.phase = "stopped";
        else if (["claiming", "resolving"].includes(current.phase))
          current.phase = current.error ? "error" : "idle";
        nextTick();
        publish();
      }
      return status();
    })();
    return flight;
  }
  function start() {
    if (!current.enabled) {
      current.enabled = true;
      update({ phase: "idle" });
      void wake();
    }
    return status();
  }
  async function stop() {
    current.enabled = false;
    clearTick();
    publish();
    if (active) await cancel(active.claim.request.request_id);
    if (flight) await flight;
    update({ phase: "stopped", running: false });
    return status();
  }
  const cancelActive = (requestId) =>
    requestId === undefined && !active
      ? Promise.resolve({ ok: true, result: { cancelled: false } })
      : cancel(
          requestId === undefined ? active.claim.request.request_id : requestId,
        );
  return Object.freeze({ start, stop, wake, cancel, cancelActive, status });
}

module.exports = { createLifecycleDispatcher };
