import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "@/stores/chatStore";
import {
  PROVIDERS,
  getProvider,
  detectProviderFromKey,
  type ProviderId,
} from "@/utils/providers";
import {
  MAX_PROFILE_NAME,
  defaultProfileName,
  normalizeProfileName,
  type CredentialProfile,
} from "@/utils/profiles";
import { listModels, listModelsForAccount, credentialHint } from "@/utils/api";
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
import { CheckCircle2, Loader2, Plus, XCircle } from "lucide-react";

const inputClass =
  "bg-field text-text-primary border-border focus-visible:ring-primary/50 transition-[border-color,box-shadow] hover:border-primary/30";

/** The newest profile first, so the one in use is the one on top. */
function byRecency(profiles: CredentialProfile[]): CredentialProfile[] {
  return [...profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

type TestState = "idle" | "loading" | "success" | "error";

/**
 * The saved-key manager: every named profile, the key it holds, and the
 * actions that create, rename, test, forget and delete one. The keys
 * themselves are never shown — only the masked tail Rust computes — and
 * only the ACTIVE profile's secret is ever in the webview.
 */
export default function ProfileManager() {
  const profiles = useChatStore((s) => s.profiles);
  const activeProfileId = useChatStore((s) => s.config.activeProfileId);

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("zen");
  const [baseUrl, setBaseUrl] = useState(getProvider("zen").defaultBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [hints, setHints] = useState<Record<string, string | null>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [testMessages, setTestMessages] = useState<Record<string, string>>(
    {},
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  /** The hint of every profile, computed in Rust (never the key). */
  const seq = useRef(0);
  const loadHints = useCallback(async () => {
    const run = ++seq.current;
    const entries = await Promise.all(
      profiles.map(async (p) => {
        const hint = await credentialHint(p.account);
        return [p.id, hint] as const;
      }),
    );
    if (run !== seq.current) return;
    setHints(Object.fromEntries(entries));
  }, [profiles]);

  useEffect(() => {
    void loadHints();
  }, [loadHints]);

  const resetForm = () => {
    setName("");
    setProvider("zen");
    setBaseUrl(getProvider("zen").defaultBaseUrl);
    setApiKey("");
    setFormError(null);
  };

  const handleProviderChange = (next: ProviderId) => {
    setProvider(next);
    setBaseUrl(getProvider(next).defaultBaseUrl);
  };

  const handleKeyChange = (value: string) => {
    setApiKey(value);
    // A pasted key identifies its provider; adopting that default saves the
    // user from picking a mismatching one.
    const detected = detectProviderFromKey(value);
    if (detected && detected !== provider) {
      setProvider(detected);
      setBaseUrl(getProvider(detected).defaultBaseUrl);
    }
  };

  const handleAdd = async () => {
    if (busy) return;
    setFormError(null);
    setBusy(true);
    try {
      const result = await useChatStore.getState().saveConnection({
        name: name || defaultProfileName(provider),
        provider,
        baseUrl,
        apiKey: apiKey.trim(),
      });
      if (!result.ok) {
        setFormError(
          result.reason === "no-key"
            ? "Enter the API key for this profile."
            : result.reason === "duplicate-name"
              ? "Another profile already uses that name."
              : "Enter a name for this profile.",
        );
        return;
      }
      resetForm();
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (profile: CredentialProfile) => {
    if (tests[profile.id] === "loading") return;
    setTests((prev) => ({ ...prev, [profile.id]: "loading" }));
    setTestMessages((prev) => ({ ...prev, [profile.id]: "" }));
    try {
      // The active profile is the only one whose key this process holds; a
      // non-active one is read from the keychain by Rust.
      const list =
        profile.id === activeProfileId
          ? await listModels(
              profile.baseUrl,
              useChatStore.getState().config.apiKey,
              profile.provider,
            )
          : await listModelsForAccount(
              profile.account,
              profile.baseUrl,
              profile.provider,
            );
      setTests((prev) => ({ ...prev, [profile.id]: "success" }));
      setTestMessages((prev) => ({
        ...prev,
        [profile.id]: `${list.length} models available.`,
      }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [profile.id]: "error" }));
      setTestMessages((prev) => ({
        ...prev,
        [profile.id]: err instanceof Error ? err.message : String(err),
      }));
    }
  };

  const handleUse = async (profile: CredentialProfile) => {
    await useChatStore.getState().activateProfile(profile.id);
  };

  const handleForget = async (profile: CredentialProfile) => {
    await useChatStore.getState().forgetProfileKey(profile.id);
    setTests((prev) => ({ ...prev, [profile.id]: "idle" }));
    setTestMessages((prev) => ({ ...prev, [profile.id]: "" }));
    void loadHints();
  };

  const handleDelete = async (profile: CredentialProfile) => {
    await useChatStore.getState().deleteProfile(profile.id);
    void loadHints();
  };

  const startRename = (profile: CredentialProfile) => {
    setRenaming(profile.id);
    setRenameValue(profile.name);
    setRenameError(null);
  };

  const commitRename = async (profile: CredentialProfile) => {
    const ok = await useChatStore.getState().renameProfile(profile.id, renameValue);
    if (!ok) {
      setRenameError(
        normalizeProfileName(renameValue)
          ? "Another profile already uses that name."
          : "Enter a name for this profile.",
      );
      return;
    }
    setRenaming(null);
    setRenameError(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">
        Each profile is one saved API key with a name of your own. Several
        profiles can share a provider. The model list below shows every
        profile&apos;s models, and picking one activates that profile.
      </p>

      {byRecency(profiles).map((profile) => {
        const active = profile.id === activeProfileId;
        const test = tests[profile.id] ?? "idle";
        const message = testMessages[profile.id] ?? "";
        return (
          <div
            key={profile.id}
            className={
              active
                ? "rounded-lg border border-primary/40 bg-primary/5 p-2.5 space-y-2"
                : "rounded-lg border border-border p-2.5 space-y-2"
            }
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                {renaming === profile.id ? (
                  <Input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    aria-label={`Rename ${profile.name}`}
                    maxLength={MAX_PROFILE_NAME}
                    autoFocus
                    className={`${inputClass} h-8`}
                  />
                ) : (
                  <p className="text-sm text-text-primary truncate">
                    {profile.name}
                    {active && (
                      <span className="ml-1.5 text-[10px] font-semibold text-primary bg-primary/10 border border-primary/30 rounded px-1 py-px uppercase tracking-wide align-middle">
                        Active
                      </span>
                    )}
                  </p>
                )}
                <p className="text-xs text-text-muted truncate">
                  {getProvider(profile.provider).label} · {profile.baseUrl}
                </p>
                <p className="text-xs text-text-muted">
                  {hints[profile.id]
                    ? `Key ${hints[profile.id]}`
                    : "No key saved"}
                </p>
              </div>
            </div>

            {renaming === profile.id ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void commitRename(profile)}>
                  Save name
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setRenaming(null);
                    setRenameError(null);
                  }}
                >
                  Cancel
                </Button>
                {renameError && (
                  <p className="text-xs text-destructive">{renameError}</p>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {!active && (
                  <button
                    type="button"
                    onClick={() => void handleUse(profile)}
                    className="text-xs text-primary hover:text-primary/80 select-none"
                  >
                    Use
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleTest(profile)}
                  disabled={test === "loading"}
                  className="text-xs text-primary hover:text-primary/80 disabled:opacity-50 select-none"
                >
                  {test === "loading" ? "Testing…" : "Test"}
                </button>
                <button
                  type="button"
                  onClick={() => startRename(profile)}
                  className="text-xs text-primary hover:text-primary/80 select-none"
                >
                  Rename
                </button>
                {hints[profile.id] && (
                  <button
                    type="button"
                    onClick={() => void handleForget(profile)}
                    className="text-xs text-destructive hover:text-destructive/80 select-none"
                  >
                    Forget key
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleDelete(profile)}
                  disabled={profiles.length <= 1}
                  title={
                    profiles.length <= 1
                      ? "The last profile cannot be deleted"
                      : "Delete this profile and its key"
                  }
                  className="text-xs text-destructive hover:text-destructive/80 disabled:opacity-40 select-none"
                >
                  Delete
                </button>
              </div>
            )}

            {test === "success" && (
              <p className="flex items-center gap-1.5 text-xs text-primary">
                <CheckCircle2 className="size-3.5" />
                {message}
              </p>
            )}
            {test === "error" && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <XCircle className="size-3.5" />
                {message}
              </p>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <div className="space-y-1.5">
            <Label className="text-text-secondary text-xs">Profile name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={defaultProfileName(provider)}
              aria-label="Profile name"
              maxLength={MAX_PROFILE_NAME}
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-text-secondary text-xs">Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) => handleProviderChange((v ?? "zen") as ProviderId)}
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
          <div className="space-y-1.5">
            <Label className="text-text-secondary text-xs">API Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={getProvider(provider).defaultBaseUrl}
              aria-label="Profile base URL"
              className={inputClass}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-text-secondary text-xs">API Key</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => handleKeyChange(e.target.value)}
              placeholder={
                getProvider(provider).keyPrefixes[0]
                  ? `${getProvider(provider).keyPrefixes[0]}…`
                  : "sk-…"
              }
              aria-label="Profile API key"
              className={inputClass}
            />
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handleAdd()}
              disabled={busy || apiKey.trim() === ""}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Save profile
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                resetForm();
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            resetForm();
            setAdding(true);
          }}
          className="w-full"
        >
          <Plus className="size-3.5" />
          Add profile
        </Button>
      )}
    </div>
  );
}
