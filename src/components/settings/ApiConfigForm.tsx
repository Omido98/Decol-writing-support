import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import {
  PROVIDERS,
  getProvider,
  detectProviderFromKey,
  type ProviderId,
} from "@/utils/providers";
import { loadCredential, normalizeEndpoint } from "@/utils/keychain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listModels,
  fetchZenPricing,
  type ZenPricingEntry,
} from "@/utils/api";
import {
  computeRemovedModelIds,
  formatModelPrice,
  isFreeModel,
  ZEN_MODEL_NAMES,
  type ModelPrice,
} from "@/utils/zenPricing";
import { getPref, setPref } from "@/utils/preferences";
import {
  RefreshCw,
  RotateCcw,
  Loader2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const CUSTOM_MODEL = "__custom__";
const REASONING_OPTIONS = [
  { value: "", label: "Default" },
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];
const inputClass =
  "bg-field text-text-primary border-border focus-visible:ring-primary/50 transition-[border-color,box-shadow] hover:border-primary/30";

/** The normalized profile identity a credential belongs to. */
const profileId = (provider: ProviderId, baseUrl: string): string =>
  `${provider}|${normalizeEndpoint(baseUrl)}`;

interface ApiConfigFormProps {
  onDone?: () => void;
}

export default function ApiConfigForm({ onDone }: ApiConfigFormProps) {
  const configLoaded = useChatStore((s) => s.configLoaded);
  const loadConfig = useChatStore((s) => s.loadConfig);

  useEffect(() => {
    if (!configLoaded) loadConfig();
  }, [configLoaded, loadConfig]);

  if (!configLoaded) {
    return <p className="text-xs text-text-muted">Loading API settings…</p>;
  }

  return <ApiConfigFormInner onDone={onDone} />;
}

function ApiConfigFormInner({ onDone }: ApiConfigFormProps) {
  const config = useChatStore((s) => s.config);
  const setConfig = useChatStore((s) => s.setConfig);

  const [provider, setProvider] = useState<ProviderId>(
    config.provider ?? "zen",
  );
  const [baseUrl, setBaseUrl] = useState(
    config.baseUrl || getProvider(config.provider ?? "zen").defaultBaseUrl,
  );
  const [urlCustomized, setUrlCustomized] = useState(false);
  const [detectedProvider, setDetectedProvider] =
    useState<ProviderId | null>(null);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [model] = useState(config.model || "");
  const [customModel, setCustomModel] = useState("");
  const [selection, setSelection] = useState<string>(model);
  const [reasoningEffort, setReasoningEffort] = useState(
    config.reasoningEffort ?? "",
  );

  const [models, setModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [pricing, setPricing] = useState<ZenPricingEntry[]>([]);
  const [pricingStatus, setPricingStatus] = useState<string | null>(null);

  const [testStatus, setTestStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [testMessage, setTestMessage] = useState("");

  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [confirmPaidOpen, setConfirmPaidOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [sessionKeyNote, setSessionKeyNote] = useState(false);

  /**
   * Profile-bound key ownership (B17b): the editable key belongs to ONE
   * normalized profile. `keyProfileRef` records which profile the field's
   * content came from ("" while unresolved) and `keyResolved` gates the
   * authenticated actions. Provider/endpoint changes clear the field
   * SYNCHRONOUSLY in the handlers, so an immediate Test/Reload/Save can
   * never send the previous profile's key to the new endpoint.
   */
  const keyProfileRef = useRef(
    profileId(
      config.provider ?? "zen",
      config.baseUrl || getProvider(config.provider ?? "zen").defaultBaseUrl,
    ),
  );
  const [keyResolved, setKeyResolved] = useState(true);
  const keySeq = useRef(0);
  const currentProfile = (p: ProviderId = provider, url: string = baseUrl) =>
    profileId(p, url.trim() || getProvider(p).defaultBaseUrl);

  /**
   * Sequence guard: profile changes (provider switch, base-url edit) must
   * discard stale model-list/test responses — a slow reply for the PREVIOUS
   * profile may never update the UI for the new one.
   */
  const requestSeq = useRef(0);

  // Connection-test status is bound to the current inputs: any change to
  // the profile (provider, endpoint, key) invalidates the last result.
  useEffect(() => {
    setTestStatus("idle");
    setTestMessage("");
  }, [provider, baseUrl, apiKey]);

  // Resolve the stored credential of the profile the form now shows. The
  // handlers invalidate synchronously; this effect only LOADS (debounced,
  // so typing an endpoint does not hit the keychain per keystroke) and
  // then refreshes the model list with the resolved key.
  useEffect(() => {
    const url = baseUrl.trim() || getProvider(provider).defaultBaseUrl;
    const target = profileId(provider, url);
    if (keyProfileRef.current === target) return;
    keySeq.current++; // any in-flight load belongs to a superseded profile
    keyProfileRef.current = "";
    setApiKey("");
    setKeyResolved(false);
    const timer = window.setTimeout(() => {
      if (keyProfileRef.current === target) return; // a typed key settled it
      const seq = ++keySeq.current;
      void loadCredential(provider, url).then((cred) => {
        if (seq !== keySeq.current) return; // a newer profile owns the state
        if (keyProfileRef.current === target) return; // typed meanwhile
        keyProfileRef.current = target;
        setApiKey(cred ?? "");
        setKeyResolved(true);
        void loadModels(url, provider, cred ?? "");
      });
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl]);

  const fetchedPrices = useMemo(() => {
    const map: Record<string, ModelPrice> = {};
    for (const entry of pricing) {
      if (!entry.is_free && entry.input != null && entry.output != null) {
        map[entry.id] = { input: entry.input, output: entry.output };
      }
    }
    return map;
  }, [pricing]);

  const fetchedFree = useMemo(
    () => new Set(pricing.filter((p) => p.is_free).map((p) => p.id)),
    [pricing],
  );

  // Model ID -> display name: static docs snapshot as base, live-scraped
  // names win when present. Unknown IDs fall back to the raw ID.
  const modelNames = useMemo(() => {
    const map: Record<string, string> = { ...ZEN_MODEL_NAMES };
    for (const entry of pricing) {
      if (entry.name) map[entry.id] = entry.name;
    }
    return map;
  }, [pricing]);

  const displayName = (id: string): string => modelNames[id] ?? id;

  // Models the Zen /models endpoint still returns but the Zen docs no longer
  // list (endpoints + pricing tables): removed or deprecated upstream, likely
  // no longer usable. Empty when pricing is unavailable (scrape failed and
  // no cache) so nothing is flagged without evidence.
  const removedIds = useMemo(
    () =>
      provider === "zen" ? computeRemovedModelIds(models ?? [], pricing) : new Set<string>(),
    [models, pricing, provider],
  );

  /** Load the model list (and Zen prices when applicable) for a provider.
   * Stale responses (profile changed meanwhile) are discarded. */
  const loadModels = useCallback(
    async (
      url: string,
      p: ProviderId = provider,
      key = apiKey.trim(),
    ): Promise<boolean> => {
      const target = url.trim() || getProvider(p).defaultBaseUrl;
      const seq = ++requestSeq.current;
      setModelsLoading(true);
      setModelsError(null);
      setPricingStatus(null);
      try {
        const list = await listModels(target, key, p);
        if (seq !== requestSeq.current) return false; // stale profile
        setModels(list);
      } catch (err) {
        if (seq !== requestSeq.current) return false; // stale profile
        setModels(null);
        setModelsError(err instanceof Error ? err.message : String(err));
      }
      let pricesOk = false;
      if (getProvider(p).hasZenPricing) {
        try {
          const entries = await fetchZenPricing();
          if (seq !== requestSeq.current) return false; // stale profile
          setPricing(entries);
          setPricingStatus(`Prices imported for ${entries.length} models`);
          await setPref("zen-prices", entries);
          pricesOk = true;
        } catch (err) {
          if (seq !== requestSeq.current) return false; // stale profile
          setPricingStatus(err instanceof Error ? err.message : String(err));
        }
      }
      setModelsLoading(false);
      return pricesOk;
    },
    [apiKey, provider],
  );

  useEffect(() => {
    let stale = false;
    void (async () => {
      const initialProvider = config.provider ?? "zen";
      const pricesOk = await loadModels(
        config.baseUrl || getProvider(initialProvider).defaultBaseUrl,
        initialProvider,
      );
      if (stale || pricesOk) return;
      if (!getProvider(initialProvider).hasZenPricing) return;
      const cached = await getPref<ZenPricingEntry[]>("zen-prices");
      if (cached && cached.length > 0) {
        setPricing(cached);
        setPricingStatus(`Using ${cached.length} prices from a previous import`);
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = useMemo(() => {
    const list = [...(models ?? [])];
    if (
      config.provider === provider &&
      model &&
      !list.includes(model) &&
      selection !== CUSTOM_MODEL
    ) {
      list.unshift(model);
    }
    // Zen only: usable models first (free models first within that group),
    // removed models sink to the bottom. Array.sort is stable, so relative
    // order is preserved within groups.
    if (provider === "zen") {
      const rank = (id: string) => {
        if (removedIds.has(id)) return 2;
        return isFreeModel(id) || fetchedFree.has(id) ? 0 : 1;
      };
      list.sort((a, b) => rank(a) - rank(b));
    }
    return list;
  }, [models, model, selection, provider, config.provider, fetchedFree, removedIds]);

  const resolvedModel =
    selection === CUSTOM_MODEL ? customModel.trim() : selection;

  const canSave =
    keyResolved &&
    apiKey.trim() !== "" &&
    (selection === CUSTOM_MODEL ? customModel.trim() !== "" : selection !== "");

  /** Whether picking this model needs no confirmation (free or unknown). */
  const isFreeChoice = (id: string): boolean => {
    if (id === CUSTOM_MODEL) return true;
    if (provider !== "zen") return true;
    return isFreeModel(id) || fetchedFree.has(id);
  };

  const handleModelSelect = (id: string) => {
    if (isFreeChoice(id)) {
      setSelection(id);
      return;
    }
    setPendingSelection(id);
    setConfirmPaidOpen(true);
  };

  const confirmPaidSelection = () => {
    if (pendingSelection) setSelection(pendingSelection);
    setPendingSelection(null);
    setConfirmPaidOpen(false);
  };

  const declinePaidSelection = () => {
    setPendingSelection(null);
    setConfirmPaidOpen(false);
  };

  /** Switch to a provider: fill its default URL + model, select THAT
   * profile's stored credential (or an empty field — never another
   * profile's key), and reload the list. `keyOverride` is only passed when
   * the caller already holds a key that belongs to THIS provider
   * (auto-detection while typing). */
  const applyProvider = (p: ProviderId, keyOverride?: string) => {
    setProvider(p);
    const def = getProvider(p);
    setBaseUrl(def.defaultBaseUrl);
    setSelection(def.defaultModel);
    setUrlCustomized(false);
    if (keyOverride !== undefined) {
      // The typed key WAS detected as this provider's key: it belongs to
      // the new profile and is safe to keep.
      keySeq.current++; // supersede any in-flight credential load
      keyProfileRef.current = profileId(p, def.defaultBaseUrl);
      setKeyResolved(true);
      setApiKey(keyOverride);
      void loadModels(def.defaultBaseUrl, p, keyOverride);
    } else {
      // Invalidate SYNCHRONOUSLY; the resolution effect loads this
      // profile's own stored credential (and reloads models with it).
      keyProfileRef.current = "";
      setKeyResolved(false);
      setApiKey("");
    }
  };

  /** An endpoint edit invalidates the current key synchronously: the
   * previous endpoint's key is never sent to the new one, not even for a
   * single click. The resolution effect loads the new profile's stored
   * credential afterwards. */
  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value);
    setUrlCustomized(true);
    const target = currentProfile(provider, value);
    if (keyProfileRef.current === target) return;
    keySeq.current++;
    keyProfileRef.current = "";
    setApiKey("");
    setKeyResolved(false);
  };

  const handleApiKeyChange = (value: string) => {
    // A typed key belongs to the profile the form is showing: it settles
    // that profile immediately and cancels any pending stored-credential
    // load (a late response must not overwrite a fresh input).
    keySeq.current++;
    keyProfileRef.current = currentProfile();
    setKeyResolved(true);
    setApiKey(value);
    const detected = detectProviderFromKey(value);
    setDetectedProvider(detected);
    if (detected && detected !== provider && !urlCustomized) {
      applyProvider(detected, value);
    }
  };

  const handleTest = async () => {
    if (!keyResolved) return;
    if (!apiKey.trim()) {
      setTestStatus("error");
      setTestMessage("Enter your API key first.");
      return;
    }
    const seq = ++requestSeq.current;
    setTestStatus("loading");
    setTestMessage("");
    try {
      const list = await listModels(
        baseUrl.trim() || getProvider(provider).defaultBaseUrl,
        apiKey.trim(),
        provider,
      );
      if (seq !== requestSeq.current) return; // stale test: inputs changed
      setModels(list);
      setTestStatus("success");
      setTestMessage(`Connected — ${list.length} models available.`);
    } catch (err) {
      if (seq !== requestSeq.current) return; // stale test: inputs changed
      setTestStatus("error");
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  };

  /** Explicit Forget: delete the credential of the profile the FORM shows
   * (not necessarily the persisted config) and clear the field. */
  const handleForget = async () => {
    const url = baseUrl.trim() || getProvider(provider).defaultBaseUrl;
    await useChatStore.getState().forgetCredential({ provider, baseUrl: url });
    keySeq.current++;
    keyProfileRef.current = currentProfile(provider, url);
    setApiKey("");
    setKeyResolved(true);
    setTestStatus("idle");
    setTestMessage("");
    setSessionKeyNote(false);
  };

  const handleSave = async () => {
    if (!keyResolved) return;
    // The key is verified into the OS keychain under THIS profile's
    // account (provider + endpoint) inside setConfig; the persisted
    // config carries only the account reference, never the secret.
    await setConfig({
      provider,
      baseUrl: baseUrl.trim() || getProvider(provider).defaultBaseUrl,
      apiKey: apiKey.trim(),
      model: resolvedModel,
      reasoningEffort: reasoningEffort.trim() !== "" ? reasoningEffort : null,
    });
    const stored = useChatStore.getState().config;
    setSessionKeyNote(stored.sessionKeyOnly);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
    onDone?.();
  };

  return (
    <>
      <div className="space-y-4">
        {/* Provider */}
        <div className="space-y-1.5">
          <Label className="text-text-secondary text-xs">Provider</Label>
          <Select
            value={provider}
            onValueChange={(v) => applyProvider((v ?? "zen") as ProviderId)}
          >
            <SelectTrigger className="w-full bg-field border-border focus-visible:ring-primary/50 data-[size=default]:h-9">
              <SelectValue>
                {(v) => getProvider((v as ProviderId) || provider).label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* API Base URL */}
        <div className="space-y-1.5">
          <Label className="text-text-secondary text-xs">API Base URL</Label>
          <div className="flex gap-2">
            <Input
              value={baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
              placeholder={getProvider(provider).defaultBaseUrl}
              aria-label="API base URL"
              className={inputClass}
            />
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={() => handleBaseUrlChange(getProvider(provider).defaultBaseUrl)}
              title="Reset to the provider's default URL"
              aria-label="Reset base URL"
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </div>
          <p className="text-xs text-text-muted">
            {provider === "zen" ? (
              <>
                OpenCode Zen uses {getProvider("zen").defaultBaseUrl}. Other
                OpenAI-compatible endpoints also work.
              </>
            ) : (
              <>
                {getProvider(provider).label}'s default URL is filled in
                automatically when you switch providers. You can edit it for
                custom endpoints — Reset restores the default.
              </>
            )}
          </p>
        </div>

        {/* API Key */}
        <div className="space-y-1.5">
          <Label className="text-text-secondary text-xs">API Key</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder={
              getProvider(provider).keyPrefixes[0]
                ? `${getProvider(provider).keyPrefixes[0]}…`
                : "sk-…"
            }
            aria-label="API key"
            className={inputClass}
          />
          {detectedProvider && detectedProvider !== provider && (
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              Detected {getProvider(detectedProvider).label} key.
              <button
                onClick={() => applyProvider(detectedProvider)}
                className="text-primary hover:text-primary/80 select-none"
              >
                Switch provider
              </button>
            </div>
          )}
          {!keyResolved && (
            <p className="text-xs text-text-muted" role="status">
              Loading this endpoint's saved credential…
            </p>
          )}
          <div className="mt-1 flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleTest}
              disabled={testStatus === "loading" || !keyResolved}
            >
              {testStatus === "loading" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Test connection
            </Button>
            {keyResolved &&
              (config.keychainAccount != null || apiKey.trim() !== "") && (
                <button
                  type="button"
                  onClick={() => void handleForget()}
                  className="text-xs text-destructive hover:text-destructive/80 select-none"
                >
                  Forget saved key
                </button>
              )}
          </div>
          {testStatus === "success" && (
            <div className="flex items-center gap-1.5 text-xs text-primary">
              <CheckCircle2 className="size-3.5" />
              {testMessage}
            </div>
          )}
          {testStatus === "error" && (
            <div className="flex items-center gap-1.5 text-xs text-destructive">
              <XCircle className="size-3.5" />
              {testMessage}
            </div>
          )}
        </div>

        {/* Model */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-text-secondary text-xs">Model</Label>
            <button
              onClick={() => loadModels(baseUrl)}
              disabled={modelsLoading || !keyResolved}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:opacity-50 select-none"
              title="Reload the model list"
            >
              {modelsLoading ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Reload models
            </button>
          </div>

          <Select
            value={selection}
            onValueChange={(v) => handleModelSelect(v ?? "")}
            disabled={modelsLoading}
          >
            <SelectTrigger className="w-full bg-field border-border focus-visible:ring-primary/50 data-[size=default]:h-9">
              <SelectValue>
                {(v) => (v ? displayName(v) : "Select a model…")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((id) => {
                const removed = provider === "zen" && removedIds.has(id);
                const free =
                  !removed &&
                  provider === "zen" &&
                  (isFreeModel(id) || fetchedFree.has(id));
                const price = free
                  ? "Free"
                  : !removed && provider === "zen"
                    ? formatModelPrice(id, fetchedPrices)
                    : null;
                return (
                  <SelectItem key={id} value={id}>
                    <span className="flex items-center justify-between gap-3 flex-1">
                      <span
                        className={
                          removed
                            ? "truncate text-text-muted"
                            : "truncate"
                        }
                      >
                        {displayName(id)}
                      </span>
                      {removed ? (
                        <span className="text-[10px] font-semibold text-destructive bg-destructive/10 border border-destructive/30 rounded px-1 py-px uppercase tracking-wide shrink-0">
                          Removed
                        </span>
                      ) : (
                        price && (
                          <span className="flex items-center gap-1.5 shrink-0">
                            <span
                              className={
                                free
                                  ? "text-xs text-primary font-medium"
                                  : "text-xs text-text-muted"
                              }
                            >
                              {price}
                            </span>
                            {free && (
                              <span className="text-[10px] font-semibold text-primary bg-green-400/10 border border-green-400/30 rounded px-1 py-px uppercase tracking-wide">
                                Free
                              </span>
                            )}
                          </span>
                        )
                      )}
                    </span>
                  </SelectItem>
                );
              })}
              <SelectItem value={CUSTOM_MODEL}>Custom model…</SelectItem>
            </SelectContent>
          </Select>

          {selection === CUSTOM_MODEL && (
            <Input
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. deepseek-v4-flash-free"
              className={inputClass}
            />
          )}

          {modelsLoading && (
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              <Loader2 className="size-3 animate-spin" />
              Loading models…
            </p>
          )}
          {!modelsLoading && modelsError && (
            <p className="text-xs text-destructive">
              Could not load models: {modelsError}
            </p>
          )}
          {!modelsLoading && !modelsError && models && (
              <p className="text-xs text-text-muted">
                {models.length} models available at this endpoint.
                {provider === "zen" && removedIds.size > 0 && (
                  <> {removedIds.size} of them are no longer offered by Zen and likely won't work.</>
                )}
                {provider === "zen" && (
                <>
                  {" "}
                  Prices per 1M tokens are imported automatically from{" "}
                  <a
                    href="https://opencode.ai/docs/zen"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:text-primary/80"
                  >
                    opencode.ai/docs/zen
                  </a>{" "}
                  every time you reload models — may change.
                </>
              )}
            </p>
          )}
          {provider === "zen" && pricingStatus && (
            <p
              className={
                pricingStatus.startsWith("Prices imported") ||
                pricingStatus.startsWith("Using")
                  ? "text-xs text-text-muted"
                  : "text-xs text-destructive"
              }
            >
              {pricingStatus}
            </p>
          )}
        </div>

        {/* Reasoning Effort */}
        {provider !== "anthropic" ? (
          <div className="space-y-1.5">
            <Label className="text-text-secondary text-xs">
              Reasoning Effort
            </Label>
            <Select
              value={reasoningEffort}
              onValueChange={(v) => setReasoningEffort(v ?? "")}
            >
              <SelectTrigger className="w-full bg-field border-border focus-visible:ring-primary/50 data-[size=default]:h-9">
                <SelectValue>
                  {(v) =>
                    v
                      ? (REASONING_OPTIONS.find((o) => o.value === v)?.label ??
                        v)
                      : "Default"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {REASONING_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value || "default"} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              How much the model should think before answering (like opencode's
              reasoning levels). Support varies by model — if a model rejects
              it, you'll see the error in chat. Default sends nothing.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label className="text-text-secondary text-xs">
              Reasoning Effort
            </Label>
            <p className="text-xs text-text-muted">
              Not configurable for Anthropic yet — Claude models handle
              reasoning on their own.
            </p>
          </div>
        )}

        {sessionKeyNote && (
          <p className="text-xs text-warning" role="note">
            Secure storage is unavailable — the key is kept for this session
            only and will need to be entered again next launch.
          </p>
        )}
        <Button
          onClick={handleSave}
          className="w-full bg-primary hover:bg-primary/80 text-primary-foreground"
          disabled={!canSave}
        >
          {saved ? "Saved" : "Save"}
        </Button>
      </div>

      {/* Paid model confirmation */}
      <Dialog open={confirmPaidOpen} onOpenChange={setConfirmPaidOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>This model costs money</DialogTitle>
            <DialogDescription>
              {pendingSelection && (
                <>
                  <span className="text-text-primary font-medium">
                    {displayName(pendingSelection)}
                  </span>{" "}
                  is not a free model
                  {provider === "zen" && (
                    <>
                      {" "}
                      (
                      {formatModelPrice(pendingSelection, fetchedPrices) ??
                        "price not listed"}
                      )
                    </>
                  )}
                  . Using it will be billed to your account. Are you sure you
                  want to use it?
                </>
              )}
              {pendingSelection && removedIds.has(pendingSelection) && (
                <span className="mt-1 block text-destructive">
                  Note: this model is no longer offered by Zen and likely
                  won't work.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={declinePaidSelection}>
              No, I want a free model
            </Button>
            <Button variant="default" onClick={confirmPaidSelection}>
              Yes, I am sure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
