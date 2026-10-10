/** Backend-only inheritance for the author's unchanged control panel.
 * The first enabled chat model is the primary model (the same ordering used
 * by the existing global image selector). Keys and endpoints stay per-provider.
 * Only role chat and the three text memory chains inherit; embeddings, vision,
 * audio, image and fallback references retain their existing semantics.
 */
const POLICY_VERSION = 1;
const empty = () => ({ provider: "", modelId: "" });
const ref = (value) => ({ provider: value?.provider || "", modelId: value?.modelId || "" });
const equal = (a, b) => a?.provider === b?.provider && a?.modelId === b?.modelId;
const complete = (value) => Boolean(value?.provider && value?.modelId);

export function primaryChatRef(config) {
  for (const provider of config?.providers ?? []) {
    if (!provider.url || provider.type === "novelai") continue;
    const model = provider.models?.find((m) => m.enabled && m.model && m.categories?.includes("chat"));
    if (model) return { provider: provider.id, modelId: model.id };
  }
  return empty();
}

function targets(config) {
  return [
    ...(config?.roles ?? []).map((role) => ({
      key: `role:${role.id}`, get: () => role.chatModel, set: (value) => { role.chatModel = value; },
    })),
    ...["memory", "memo", "diary"].filter((name) => config?.memories?.[name]).map((name) => ({
      key: `memory:${name}`, get: () => config.memories[name].model,
      set: (value) => { config.memories[name].model = value; },
    })),
  ];
}

/** Called before normalization so a user edit is not overwritten by inheritance.
 * Read the policy from the backend's previous state even when an older panel
 * discards unknown fields. Clearing a selector restores automatic inheritance.
 */
export function prepareModelDefaults(input, previous) {
  const result = { ...input };
  const policy = previous?.modelDefaults;
  if (policy?.version !== POLICY_VERSION) return result;
  const oldTargets = new Map(targets(previous).map((t) => [t.key, t.get()]));
  const overrides = new Map(Object.entries(policy.overrides ?? {}));
  const primary = primaryChatRef(previous);
  for (const target of targets(input)) {
    const value = ref(target.get());
    const oldValue = ref(oldTargets.get(target.key));
    if (!complete(value)) overrides.delete(target.key);
    else if (!equal(value, oldValue)) {
      // Selecting the current primary explicitly also returns to follow mode.
      if (equal(value, primary)) overrides.delete(target.key);
      else overrides.set(target.key, true);
    }
  }
  result.modelDefaults = { ...policy, overrides: Object.fromEntries(overrides) };
  return result;
}

/** Materialize inherited references for existing consumers and the stock UI.
 * One-time migration starts all covered text tasks in follow mode, while keeping
 * old references in a non-secret migration snapshot for recovery.
 */
export function applyModelDefaults(config, raw) {
  const list = targets(config);
  const previous = raw?.modelDefaults;
  const migrating = previous?.version !== POLICY_VERSION;
  const overrides = migrating ? {} : previous.overrides ?? {};
  const policy = {
    version: POLICY_VERSION,
    overrides: Object.fromEntries(list.filter((t) => overrides[t.key] === true).map((t) => [t.key, true])),
    originalRefs: migrating
      ? Object.fromEntries(list.map((t) => [t.key, ref(t.get())]))
      : previous.originalRefs ?? {},
  };
  const primary = primaryChatRef(config);
  for (const target of list) {
    if (!policy.overrides[target.key]) target.set({ ...primary });
  }
  config.modelDefaults = policy;
  return config;
}
