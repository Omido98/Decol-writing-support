import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listModels,
  listModelsForAccount,
  fetchZenPricing,
  type ZenPricingEntry,
} from "@/utils/api";
import { getProvider } from "@/utils/providers";
import type { CredentialProfile } from "@/utils/profiles";
import {
  computeRemovedModelIds,
  formatModelPrice,
  isFreeModel,
  ZEN_MODEL_NAMES,
  type ModelPrice,
} from "@/utils/zenPricing";
import { getPref, setPref } from "@/utils/preferences";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RefreshCw, Loader2 } from "lucide-react";

/** The escape hatch: a model id the endpoint does not list. */
export const CUSTOM_MODEL = "__custom__";

/**
 * A picker's row value must be unique, and the SAME model id can exist on
 * several profiles (a Zen key and a second Zen key see the same list). The
 * value therefore carries the profile: a profile id is a uuid and never
 * contains ":", so splitting on the first "::" is unambiguous.
 */
export function selectionValue(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

/** The (profile, model) pair a row value encodes; null for the sentinels. */
export function parseSelection(
  value: string,
): { profileId: string; model: string } | null {
  const at = value.indexOf("::");
  if (at <= 0) return null;
  return { profileId: value.slice(0, at), model: value.slice(at + 2) };
}

/** How many profiles' model lists are fetched at the same time. */
const MAX_PARALLEL_FETCHES = 4;

/** One profile's rows, with the badges resolved against ITS provider. */
export interface ModelGroup {
  profile: CredentialProfile;
  models: string[];
  removed: Set<string>;
  /** Whether this provider's models carry price/free badges at all. */
  priced: boolean;
  free: Set<string>;
}

/**
 * The rows of every profile, in profile order. Two profiles may return the
 * SAME model id; each keeps its own copy, because they are different
 * accounts and picking one activates that profile.
 *
 * A profile's current selection is pinned into its own group even when the
 * endpoint no longer lists it (a custom or since-removed model), and Zen
 * rows are ordered usable-first (free first) with removed ones last.
 */
export function buildModelGroups(
  profiles: CredentialProfile[],
  modelsByProfile: Record<string, string[]>,
  pricing: ZenPricingEntry[],
  selection: string,
  fetchedFree: Set<string>,
): ModelGroup[] {
  const current = parseSelection(selection);
  const groups: ModelGroup[] = [];
  for (const profile of profiles) {
    const priced = getProvider(profile.provider).hasZenPricing === true;
    const list = [...(modelsByProfile[profile.id] ?? [])];
    if (current && current.profileId === profile.id && current.model && !list.includes(current.model)) {
      list.unshift(current.model);
    }
    const removed = priced
      ? computeRemovedModelIds(list, pricing)
      : new Set<string>();
    if (priced) {
      // Array.sort is stable, so relative order is preserved within groups.
      const rank = (id: string) => {
        if (removed.has(id)) return 2;
        return isFreeModel(id) || fetchedFree.has(id) ? 0 : 1;
      };
      list.sort((a, b) => rank(a) - rank(b));
    }
    groups.push({ profile, models: list, removed, priced, free: fetchedFree });
  }
  return groups;
}

/** What one profile's model list resolved to. */
type ListStatus =
  | { state: "loading" }
  | { state: "ok"; count: number }
  | { state: "error"; message: string };

interface ModelPickerProps {
  profiles: CredentialProfile[];
  activeProfileId: string | null;
  /** The active profile's key: a session-only key exists nowhere else. */
  activeApiKey: string;
  /** The current row value (`""`, CUSTOM_MODEL, or selectionValue(...)). */
  selection: string;
  onSelect: (profileId: string, model: string) => void;
  customModel: string;
  onCustomModelChange: (value: string) => void;
}

/**
 * The model list of EVERY saved profile, grouped by profile.
 *
 * Each group's rows carry the profile they came from, so choosing a model
 * from another profile activates that profile — the user picks the model
 * AND the key it will be sent with in one place. The active profile is read
 * with its in-memory key (it may be a freshly typed or session-only one);
 * every other profile is read by Rust from the keychain, so its secret never
 * enters the webview.
 */
export default function ModelPicker({
  profiles,
  activeProfileId,
  activeApiKey,
  selection,
  onSelect,
  customModel,
  onCustomModelChange,
}: ModelPickerProps) {
  const [modelsByProfile, setModelsByProfile] = useState<
    Record<string, string[]>
  >({});
  const [statuses, setStatuses] = useState<Record<string, ListStatus>>({});
  const [pricing, setPricing] = useState<ZenPricingEntry[]>([]);
  const [pricingStatus, setPricingStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<{
    profileId: string;
    model: string;
  } | null>(null);
  /** Stale-response guard: only the newest run may publish results. */
  const seq = useRef(0);

  const hasZen = useMemo(
    () => profiles.some((p) => getProvider(p.provider).hasZenPricing),
    [profiles],
  );

  /**
   * Fetch every profile's model list, at most MAX_PARALLEL_FETCHES at a
   * time. Results are published as they land, so one slow profile never
   * holds up the rest; a superseded run publishes nothing.
   */
  const fetchAll = useCallback(async () => {
    const run = ++seq.current;
    setLoading(true);
    const collected: Record<string, string[]> = {};
    const statusesNext: Record<string, ListStatus> = {};
    setStatuses(
      Object.fromEntries(
        profiles.map((p) => [p.id, { state: "loading" } as ListStatus]),
      ),
    );
    const fetchOne = async (profile: CredentialProfile) => {
      const list =
        profile.id === activeProfileId && activeApiKey
          ? await listModels(profile.baseUrl, activeApiKey, profile.provider)
          : await listModelsForAccount(
              profile.account,
              profile.baseUrl,
              profile.provider,
            );
      return list;
    };
    let next = 0;
    const worker = async () => {
      while (next < profiles.length) {
        const index = next++;
        const profile = profiles[index];
        try {
          const list = await fetchOne(profile);
          collected[profile.id] = list;
          statusesNext[profile.id] = { state: "ok", count: list.length };
        } catch (err) {
          collected[profile.id] = [];
          statusesNext[profile.id] = {
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          };
        }
        if (run === seq.current) {
          setModelsByProfile({ ...collected });
          setStatuses({ ...statusesNext });
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_PARALLEL_FETCHES, profiles.length) },
        worker,
      ),
    );
    if (run !== seq.current) return;
    setLoading(false);
  }, [profiles, activeProfileId, activeApiKey]);

  useEffect(() => {
    if (profiles.length === 0) return;
    void fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, activeProfileId, activeApiKey]);

  // Pricing is endpoint-independent (it is Zen's public price table, and it
  // takes no key): fetched once for all Zen profiles, with a cached copy as
  // the fallback when the scrape fails.
  useEffect(() => {
    if (!hasZen) return;
    let stale = false;
    void (async () => {
      try {
        const entries = await fetchZenPricing();
        if (stale) return;
        setPricing(entries);
        setPricingStatus(`Prices imported for ${entries.length} models`);
        await setPref("zen-prices", entries);
      } catch (err) {
        if (stale) return;
        setPricingStatus(err instanceof Error ? err.message : String(err));
        const cached = await getPref<ZenPricingEntry[]>("zen-prices").catch(() => null);
        if (stale || !cached?.length) return;
        setPricing(cached);
        setPricingStatus(`Using ${cached.length} prices from a previous import`);
      }
    })();
    return () => {
      stale = true;
    };
  }, [hasZen]);

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

  const modelNames = useMemo(() => {
    const map: Record<string, string> = { ...ZEN_MODEL_NAMES };
    for (const entry of pricing) {
      if (entry.name) map[entry.id] = entry.name;
    }
    return map;
  }, [pricing]);

  const displayName = (id: string): string => modelNames[id] ?? id;

  const groups = useMemo(
    () => buildModelGroups(profiles, modelsByProfile, pricing, selection, fetchedFree),
    [profiles, modelsByProfile, pricing, selection, fetchedFree],
  );

  /** Whether picking this model on this profile needs no confirmation. */
  const isFreeChoice = (profile: CredentialProfile, id: string): boolean => {
    if (getProvider(profile.provider).hasZenPricing !== true) return true;
    return isFreeModel(id) || fetchedFree.has(id);
  };

  const handleSelect = (value: string) => {
    if (value === CUSTOM_MODEL) {
      onSelect(activeProfileId ?? "", CUSTOM_MODEL);
      return;
    }
    const parsed = parseSelection(value);
    if (!parsed) return;
    const profile = profiles.find((p) => p.id === parsed.profileId);
    if (profile && !isFreeChoice(profile, parsed.model)) {
      setPending({ profileId: parsed.profileId, model: parsed.model });
      return;
    }
    onSelect(parsed.profileId, parsed.model);
  };

  const confirmPending = () => {
    if (pending) onSelect(pending.profileId, pending.model);
    setPending(null);
  };

  const selectedLabel = (): string => {
    if (selection === CUSTOM_MODEL) {
      return customModel.trim() ? `${customModel.trim()} (custom)` : "Custom model…";
    }
    const parsed = parseSelection(selection);
    if (!parsed) return "Select a model…";
    const profile = profiles.find((p) => p.id === parsed.profileId);
    return profile
      ? `${displayName(parsed.model)} — ${profile.name}`
      : displayName(parsed.model);
  };

  const pendingProfile = profiles.find((p) => p.id === pending?.profileId);
  const pendingRemoved = Boolean(
    pending && groups.find((g) => g.profile.id === pending.profileId)?.removed.has(pending.model),
  );

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-text-secondary text-xs">Model</span>
          <button
            onClick={() => void fetchAll()}
            disabled={loading || profiles.length === 0}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 disabled:opacity-50 select-none"
            title="Reload the model list of every profile"
          >
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Reload models
          </button>
        </div>

        <Select
          value={selection}
          onValueChange={(v) => handleSelect(v ?? "")}
          disabled={loading || profiles.length === 0}
        >
          <SelectTrigger className="w-full bg-field border-border focus-visible:ring-primary/50 data-[size=default]:h-9">
            <SelectValue>{() => selectedLabel()}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) => {
              if (group.models.length === 0) return null;
              return (
                <SelectGroup key={group.profile.id}>
                  <SelectLabel>
                    {group.profile.name} ·{" "}
                    {getProvider(group.profile.provider).label}
                  </SelectLabel>
                  {group.models.map((id) => {
                    const removed = group.removed.has(id);
                    const free =
                      !removed && group.priced && (isFreeModel(id) || group.free.has(id));
                    const price = free
                      ? "Free"
                      : !removed && group.priced
                        ? formatModelPrice(id, fetchedPrices)
                        : null;
                    return (
                      <SelectItem
                        key={id}
                        value={selectionValue(group.profile.id, id)}
                      >
                        <span className="flex items-center justify-between gap-3 flex-1">
                          <span
                            className={
                              removed ? "truncate text-text-muted" : "truncate"
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
                </SelectGroup>
              );
            })}
            <SelectItem value={CUSTOM_MODEL}>Custom model…</SelectItem>
          </SelectContent>
        </Select>

        {selection === CUSTOM_MODEL && (
          <Input
            value={customModel}
            onChange={(e) => onCustomModelChange(e.target.value)}
            placeholder="e.g. deepseek-v4-flash-free"
            aria-label="Custom model"
            className="bg-field text-text-primary border-border focus-visible:ring-primary/50 transition-[border-color,box-shadow] hover:border-primary/30"
          />
        )}

        {profiles.map((profile) => {
          const status = statuses[profile.id];
          if (!status) return null;
          return (
            <p key={profile.id} className="text-xs text-text-muted">
              <span className="text-text-secondary">{profile.name}:</span>{" "}
              {status.state === "loading" && (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" />
                  loading models…
                </span>
              )}
              {status.state === "ok" && `${status.count} models available.`}
              {status.state === "error" && (
                <span className="text-destructive">{status.message}</span>
              )}
              {profile.id !== activeProfileId && status.state === "error" && (
                <span> — this profile contributes no models.</span>
              )}
            </p>
          );
        })}
        {hasZen && pricingStatus && (
          <p
            className={
              pricingStatus.startsWith("Prices imported") ||
              pricingStatus.startsWith("Using")
                ? "text-xs text-text-muted"
                : "text-xs text-destructive"
            }
          >
            {pricingStatus} Prices per 1M tokens come from{" "}
            <a
              href="https://opencode.ai/docs/zen"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:text-primary/80"
            >
              opencode.ai/docs/zen
            </a>{" "}
            and may change.
          </p>
        )}
      </div>

      {/* Paid model confirmation */}
      <Dialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>This model costs money</DialogTitle>
            <DialogDescription>
              {pending && (
                <>
                  <span className="text-text-primary font-medium">
                    {displayName(pending.model)}
                  </span>{" "}
                  is not a free model
                  {pendingProfile &&
                    getProvider(pendingProfile.provider).hasZenPricing === true && (
                      <>
                        {" "}
                        (
                        {formatModelPrice(pending.model, fetchedPrices) ??
                          "price not listed"}
                        )
                      </>
                    )}
                  . Using it will be billed to the{" "}
                  {pendingProfile?.name ?? "selected"} account. Are you sure
                  you want to use it?
                </>
              )}
              {pending && pendingRemoved && (
                <span className="mt-1 block text-destructive">
                  Note: this model is no longer offered by Zen and likely
                  won&apos;t work.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              No, I want a free model
            </Button>
            <Button variant="default" onClick={confirmPending}>
              Yes, I am sure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
