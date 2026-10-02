import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import {
  PROVIDERS,
  getProvider,
  detectProviderFromKey,
  type ProviderId,
} from "@/utils/providers";
import { loadProfileCredential } from "@/utils/keychain";
import { isSameEndpoint, type CredentialProfile } from "@/utils/profiles";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listModels } from "@/utils/api";
import ModelPicker, {
  CUSTOM_MODEL,
  parseSelection,
  selectionValue,
} from "@/components/settings/ModelPicker";
import { Button } from "@/components/ui/button";
import { RotateCcw, Loader2, RefreshCw, CheckCircle2, XCircle } from "lucide-react";

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
  const profiles = useChatStore((s) => s.profiles);

  const activeProfile: CredentialProfile | undefined = useChatStore((s) =>
    s.profiles.find((p) => p.id === s.config.activeProfileId),
  );

  const [provider, setProvider] = useState<ProviderId>(config.provider);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [urlCustomized, setUrlCustomized] = useState(false);
  const [detectedProvider, setDetectedProvider] =
    useState<ProviderId | null>(null);
  const [apiKey, setApiKey] = useState(config.apiKey);
  const [customModel, setCustomModel] = useState("");
  const [selection, setSelection] = useState<string>(
    activeProfile
      ? selectionValue(activeProfile.id, activeProfile.lastModel ?? config.model)
      : "",
  );
  const [reasoningEffort, setReasoningEffort] = useState(
    config.reasoningEffort ?? "",
  );

  const [testStatus, setTestStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [testMessage, setTestMessage] = useState("");

  const [saved, setSaved] = useState(false);
  const [sessionKeyNote, setSessionKeyNote] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * Key ownership: the editable key field belongs to ONE profile, at ONE
   * provider/endpoint. `keyProfileRef` records which ("" while unresolved)
   * and `keyResolved` gates the authenticated actions, so a key can never
   * be sent to an endpoint it was not typed for — not even for a single
   * click.
   */
  const keyOwner = (p: ProviderId, url: string): string =>
    `${p}|${url.trim() || getProvider(p).defaultBaseUrl}`;
  const keyProfileRef = useRef(
    activeProfile
      ? `${activeProfile.id}|${keyOwner(activeProfile.provider, activeProfile.baseUrl)}`
      : "",
  );
  const [keyResolved, setKeyResolved] = useState(true);
  const keySeq = useRef(0);
  /** Stale-response guard for the model/test calls below. */
  const requestSeq = useRef(0);

  /**
   * A switch of the ACTIVE profile (from the saved-keys manager or by
   * picking another profile's model) re-aims every field at that profile:
   * its endpoint, its key, its model. The ref is updated FIRST so the
   * credential-resolution effect below, which runs in the same commit with
   * the previous state, cannot clear the key it just settled.
   */
  const activeIdRef = useRef(config.activeProfileId);
  const activeProfileId = config.activeProfileId;
  useEffect(() => {
    const profile = useChatStore
      .getState()
      .profiles.find((p) => p.id === activeProfileId);
    if (!profile) return;
    const state = useChatStore.getState().config;
    keySeq.current++;
    activeIdRef.current = profile.id;
    keyProfileRef.current = `${profile.id}|${keyOwner(profile.provider, profile.baseUrl)}`;
    setProvider(profile.provider);
    setBaseUrl(profile.baseUrl);
    setUrlCustomized(false);
    setDetectedProvider(null);
    setApiKey(state.apiKey);
    setSelection(selectionValue(profile.id, profile.lastModel ?? state.model));
    setCustomModel("");
    setTestStatus("idle");
    setTestMessage("");
    setKeyResolved(true);
  }, [activeProfileId]);

  // The typed key belongs to the endpoint the form shows. An endpoint edit
  // invalidates it synchronously; this effect then resolves whatever THAT
  // profile has stored (debounced, so typing a URL does not hit the
  // keychain per keystroke).
  useEffect(() => {
    const url = baseUrl.trim() || getProvider(provider).defaultBaseUrl;
    const id = activeIdRef.current;
    const target = `${id ?? ""}|${keyOwner(provider, url)}`;
    if (keyProfileRef.current === target) return;
    keySeq.current++; // any in-flight load belongs to a superseded profile
    keyProfileRef.current = "";
    setApiKey("");
    setKeyResolved(false);
    const account =
      useChatStore.getState().profiles.find((p) => p.id === id)?.account ?? "";
    if (!id || !account) {
      keyProfileRef.current = target;
      setKeyResolved(true);
      return;
    }
    const timer = window.setTimeout(() => {
      if (keyProfileRef.current === target) return; // a typed key settled it
      const seq = ++keySeq.current;
      void loadProfileCredential(account).then((cred) => {
        if (seq !== keySeq.current) return; // a newer profile owns the state
        if (keyProfileRef.current === target) return; // typed meanwhile
        keyProfileRef.current = target;
        setApiKey(cred ?? "");
        setKeyResolved(true);
      });
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl]);

  // Connection-test status is bound to the current inputs: any change to
  // the endpoint or the key invalidates the last result.
  useEffect(() => {
    setTestStatus("idle");
    setTestMessage("");
  }, [provider, baseUrl, apiKey]);

  /** Switch the edit target to another provider's defaults. */
  const applyProvider = (p: ProviderId, keyOverride?: string) => {
    setProvider(p);
    setBaseUrl(getProvider(p).defaultBaseUrl);
    setUrlCustomized(false);
    if (keyOverride !== undefined) {
      // The typed key WAS detected as this provider's key: it belongs to
      // the endpoint now shown and is safe to keep.
      keySeq.current++;
      keyProfileRef.current = `${activeProfileId ?? ""}|${keyOwner(p, getProvider(p).defaultBaseUrl)}`;
      setKeyResolved(true);
      setApiKey(keyOverride);
    } else {
      // Invalidate SYNCHRONOUSLY; the resolution effect loads what this
      // profile has stored.
      keyProfileRef.current = "";
      setKeyResolved(false);
      setApiKey("");
    }
  };

  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value);
    setUrlCustomized(true);
    const target = `${activeProfileId ?? ""}|${keyOwner(provider, value)}`;
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
    keyProfileRef.current = `${activeProfileId ?? ""}|${keyOwner(provider, baseUrl)}`;
    setKeyResolved(true);
    setApiKey(value);
    const detected = detectProviderFromKey(value);
    setDetectedProvider(detected);
    if (detected && detected !== provider && !urlCustomized) {
      applyProvider(detected, value);
    }
  };

  const handleTest = useCallback(async () => {
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
      setTestStatus("success");
      setTestMessage(`Connected — ${list.length} models available.`);
    } catch (err) {
      if (seq !== requestSeq.current) return; // stale test: inputs changed
      setTestStatus("error");
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  }, [apiKey, baseUrl, keyResolved, provider]);

  /** Explicit forget: delete the ACTIVE profile's stored key. */
  const handleForget = async () => {
    const id = useChatStore.getState().config.activeProfileId;
    if (!id) return;
    await useChatStore.getState().forgetProfileKey(id);
    const url = baseUrl.trim() || getProvider(provider).defaultBaseUrl;
    keySeq.current++;
    keyProfileRef.current = `${id}|${keyOwner(provider, url)}`;
    setApiKey("");
    setKeyResolved(true);
    setTestStatus("idle");
    setTestMessage("");
    setSessionKeyNote(false);
  };

  /**
   * A model was picked in the union list. A row from ANOTHER profile means
   * "send this model with that profile's key", so the active profile
   * switches first and the form re-aims itself (see the effect above).
   */
  const handleModelSelect = async (profileId: string, model: string) => {
    if (model === CUSTOM_MODEL) {
      setSelection(CUSTOM_MODEL);
      return;
    }
    setCustomModel("");
    if (profileId && profileId !== useChatStore.getState().config.activeProfileId) {
      await useChatStore.getState().activateProfile(profileId, model);
      return; // the profile switch re-aims the form, selection included
    }
    setSelection(selectionValue(profileId || (config.activeProfileId ?? ""), model));
  };

  const parsed = parseSelection(selection);
  const resolvedModel =
    selection === CUSTOM_MODEL
      ? customModel.trim()
      : (parsed?.model ?? config.model);

  /** Whether the form now describes a connection other than the active one. */
  const newConnection = Boolean(
    activeProfile && !isSameEndpoint(activeProfile, { provider, baseUrl }),
  );

  const canSave =
    keyResolved &&
    (apiKey.trim() !== "" || !newConnection) &&
    (selection === CUSTOM_MODEL ? customModel.trim() !== "" : selection !== "");

  const handleSave = async () => {
    if (!keyResolved) return;
    setSaveError(null);
    // The ONE credential write path: the key is verified into the profile's
    // own keychain account inside saveConnection, and the persisted config
    // and profile record carry only references, never the secret. An
    // endpoint the user changed becomes a NEW profile — a key never follows
    // a profile to a different endpoint.
    const result = await useChatStore.getState().saveConnection({
      profileId: newConnection ? null : (config.activeProfileId ?? null),
      // A new connection gets an auto-generated name: the typed key's
      // profile name belongs to the profile that stays on the old endpoint.
      name: newConnection ? "" : (activeProfile?.name ?? ""),
      provider,
      baseUrl: baseUrl.trim() || getProvider(provider).defaultBaseUrl,
      apiKey: apiKey.trim(),
      model: resolvedModel,
    });
    if (!result.ok) {
      setSaveError(
        result.reason === "no-key"
          ? "Enter the API key for this connection before saving."
          : result.reason === "duplicate-name"
            ? "Another profile already uses that name."
            : "This connection could not be saved.",
      );
      return;
    }
    setSessionKeyNote(result.sessionKeyOnly);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
    onDone?.();
  };

  return (
    <div className="space-y-4">
      {activeProfile && (
        <p className="text-xs text-text-muted">
          Editing profile <span className="text-text-primary">{activeProfile.name}</span>.
          Add, rename or delete profiles in{" "}
          <span className="text-text-primary">Saved keys</span> above.
        </p>
      )}

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
              {getProvider(provider).label}&apos;s default URL is filled in
              automatically when you switch providers. You can edit it for
              custom endpoints — Reset restores the default.
            </>
          )}
        </p>
        {newConnection && (
          <p className="text-xs text-warning" role="note">
            This is a different provider or endpoint. Saving adds it as a new
            profile; &ldquo;{activeProfile?.name}&rdquo; keeps its own key.
          </p>
        )}
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
            Loading this endpoint&apos;s saved key…
          </p>
        )}
        <div className="mt-1 flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleTest()}
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

      {/* Model (every profile's models, grouped) */}
      <ModelPicker
        profiles={profiles}
        activeProfileId={config.activeProfileId}
        activeApiKey={config.apiKey}
        selection={selection}
        onSelect={(profileId, model) => void handleModelSelect(profileId, model)}
        customModel={customModel}
        onCustomModelChange={setCustomModel}
      />

      {/* Reasoning Effort */}
      {provider !== "anthropic" ? (
        <div className="space-y-1.5">
          <Label className="text-text-secondary text-xs">Reasoning Effort</Label>
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
          <Label className="text-text-secondary text-xs">Reasoning Effort</Label>
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
      {saveError && (
        <p className="text-xs text-destructive" role="alert">
          {saveError}
        </p>
      )}
      <Button
        onClick={() => void handleSave()}
        className="w-full bg-primary hover:bg-primary/80 text-primary-foreground"
        disabled={!canSave}
      >
        {saved ? "Saved" : "Save"}
      </Button>
    </div>
  );
}
