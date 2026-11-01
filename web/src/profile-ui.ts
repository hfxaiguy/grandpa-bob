/**
 * Toolbar UI for workspace profiles, seed bindings and BobSwap sharing.
 *
 * Kept out of `main.ts` so boot stays a readable sequence: this module only
 * wires dialogs to the pure-ish layers in `profiles.ts` / `swap.ts`. All
 * content that moves through a relay is assembled and imported by the browser;
 * this file never persists it.
 */
import {
  DEFAULT_PROFILE,
  activateProfile,
  createProfile,
  deleteProfile,
  isValidProfileName,
  isValidSeedName,
  profileHandle,
  recordSeedVersion,
  setProfileVisibleApps,
  setSeedBinding,
  unbindDesktopMirror,
  type ProfileRecord,
  type ProfileRegistry,
  type SeedBinding,
} from "./profiles";
import {
  activeSwapService,
  DEFAULT_SWAP_SERVICE_URL,
  defaultSwapService,
  fetchLatestSeed,
  listSeeds,
  listSwapServices,
  loadSwapStore,
  probeLatestSeed,
  publishSeed,
  receiveWorkspace,
  resolveSwapService,
  saveSwapService,
  sendWorkspace,
  type RelayChannelInfo,
  type RelayProgress,
  type RemoteSeedMeta,
  type SwapService,
} from "./swap";
import {
  buildWorkspaceArchive,
  summarizeWorkspace,
  validateWorkspaceArchive,
  type WorkspaceArchive,
} from "./workspace-transfer";
import { loadOrCreateDevice, saveDeviceName } from "./device-keys";
import { clearServerLink } from "./server-link";
import type { MirrorStatus } from "./peer-status";

export interface ProfileUiHooks {
  activeProfile(): string;
  registry(): ProfileRegistry;
  flash(text: string, ms?: number): void;
  reload(): void;
  refreshRegistry(): Promise<ProfileRegistry>;
  /** Pull a binding's newest seed into the ACTIVE profile (banner path). */
  applySeedUpdate(binding: SeedBinding, meta: RemoteSeedMeta, version?: string): Promise<void>;
  /** Archive whatever workspace BOB currently operates on. */
  buildActiveArchive(): Promise<WorkspaceArchive>;
  /** Merge into an OPFS profile. */
  importInto(target: string, archive: WorkspaceArchive): Promise<number>;
  /** Run the active profile's desktop mirror now. */
  syncMirror(): Promise<void>;
  /** Current desktop-mirror status (null when this profile has none). */
  mirrorStatus(): MirrorStatus | null;
}

const ACCOUNT_RE = /^[a-z0-9._-]{1,64}$/;

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

// ── shared state ─────────────────────────────────────────────────────────

let hooks: ProfileUiHooks | null = null;
let seedDialogProfile = "";
let seedDialogMode: "binding" | "service" = "binding";
let pendingSeedCheck: { meta: RemoteSeedMeta; version?: string } | null = null;
let shareAbort: AbortController | null = null;
let receiveAbort: AbortController | null = null;
/** Cached top-level app names; the workspace's app folders rarely change. */
let appNames: string[] | null = null;
let hiddenProfile = "";

function getHooks(): ProfileUiHooks {
  if (!hooks) throw new Error("profile UI is not wired");
  return hooks;
}

/** Build a service object from the seed form fields (unsaved included). */
function serviceFromSeedFields(): SwapService | null {
  const baseUrl = el<HTMLInputElement>("seed-base-url")?.value.trim() ?? "";
  if (!baseUrl) return null;
  return {
    baseUrl,
    realtimeUrl: el<HTMLInputElement>("seed-realtime-url")?.value.trim() || undefined,
    realtimeKey: el<HTMLInputElement>("seed-realtime-key")?.value.trim() || undefined,
    account: el<HTMLInputElement>("seed-account")?.value.trim() || undefined,
    readKey: el<HTMLInputElement>("seed-read-key")?.value.trim() || undefined,
    uploadKey: el<HTMLInputElement>("seed-upload-key")?.value.trim() || undefined,
  };
}

function fillServiceFields(service: SwapService | null): void {
  const set = (id: string, value: string | undefined): void => {
    const input = el<HTMLInputElement>(id);
    if (input) input.value = value ?? "";
  };
  // A fresh setup defaults to the public BobSwap deployment; saved services
  // and per-profile bindings still win.
  const value = service ?? defaultSwapService();
  set("seed-base-url", value.baseUrl);
  set("seed-realtime-url", value.realtimeUrl);
  set("seed-realtime-key", value.realtimeKey);
  set("seed-account", value.account);
  set("seed-read-key", value.readKey);
  set("seed-upload-key", value.uploadKey);
}

// ── profile picker + manager ─────────────────────────────────────────────

function renderProfileSelect(): void {
  const select = el<HTMLSelectElement>("profile-select");
  if (!select) return;
  const ui = getHooks();
  const registry = ui.registry();
  select.replaceChildren(
    ...registry.profiles.map((profile) => {
      const option = document.createElement("option");
      option.value = profile.name;
      const kind = profile.kind === "desktop" ? ` (desktop mirror: ${profile.folder})` : "";
      option.textContent = `${profile.name === DEFAULT_PROFILE ? "default" : profile.name}${kind}`;
      return option;
    }),
  );
  select.value = ui.activeProfile();
}

async function renderProfileList(): Promise<void> {
  const list = el<HTMLDivElement>("profile-list");
  if (!list) return;
  const ui = getHooks();
  const registry = await ui.refreshRegistry();
  const mirror = ui.mirrorStatus();
  list.replaceChildren();

  for (const profile of registry.profiles) {
    const row = document.createElement("div");
    row.className = "profile-row";

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = profile.name;
    const details = document.createElement("span");
    details.className = "muted";
    details.textContent = " · …";
    info.append(name, details);
    if (profile.seed) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = `seed: ${profile.seed.account}/${profile.seed.seedName}`;
      info.append(" ", badge);
    }
    if (Array.isArray(profile.visibleApps)) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = profile.visibleApps.length
        ? `hidden except: ${profile.visibleApps.join(", ")}`
        : "only trunk visible";
      badge.title = profile.visibleApps.length
        ? `These tiles stay on the board; every other app starts in the hidden rail: ${profile.visibleApps.join(", ")}`
        : "Only trunk shows by default; every other app starts in the hidden rail";
      info.append(" ", badge);
    }

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const isActive = profile.name === ui.activeProfile();
    const mirrorBound = profile.kind === "desktop" && !!profile.folder;
    if (!isActive) {
      actions.append(
        actionButton("Switch", () => {
          activateProfile(profile.name);
          ui.reload();
        }),
      );
    }

    actions.append(
      actionButton("Hidden… except:", () => void openHiddenDialog(profile)),
      actionButton("Seed…", () => void openSeedDialog(profile)),
      actionButton("Publish…", () => void publishProfile(profile)),
    );
    if (mirrorBound && isActive && mirror) {
      actions.append(
        actionButton("Sync now", () => {
          void (async () => {
            try {
              await ui.syncMirror();
              ui.flash(`desktop mirror synced (${profile.folder})`, 6000);
            } catch (err) {
              ui.flash(`mirror sync failed: ${errorText(err)}`, 10_000);
            }
            await renderProfileList();
          })();
        }),
      );
    }
    if (mirrorBound) {
      actions.append(
        actionButton(
          "Unbind",
          () => {
            if (
              !confirm(
                `Remove the desktop mirror "${profile.folder}" from profile "${profile.name}"?\n\n` +
                  "The OPFS workspace and the folder itself are kept.",
              )
            ) {
              return;
            }
            clearServerLink(profile.name);
            void unbindDesktopMirror(profile.name)
              .then(async () => {
                if (isActive) {
                  ui.reload();
                  return;
                }
                await renderProfileList();
                renderProfileSelect();
              })
              .catch((err) => ui.flash(`unbind failed: ${errorText(err)}`, 8000));
          },
          true,
        ),
      );
    }
    if (profile.name !== DEFAULT_PROFILE && !isActive) {
      actions.append(
        actionButton(
          "Delete",
          () => {
            if (!confirm(`Delete profile "${profile.name}" and its workspace from this browser?`)) return;
            void deleteProfile(profile.name)
              .then(() => renderProfileList())
              .catch((err) => ui.flash(`delete failed: ${errorText(err)}`, 8000));
          },
          true,
        ),
      );
    }

    row.append(info, actions);
    list.append(row);

    if (mirrorBound) {
      // The workspace is still this browser's OPFS; name the synced folder
      // and, for the active profile, how the last mirror pass went.
      const state = isActive && mirror ? ` · ${mirror.detail}` : "";
      details.textContent = ` · desktop mirror: ${profile.folder}${state}`;
      continue;
    }
    void summarizeWorkspace(await profileHandle(profile.name))
      .then((summary) => {
        details.textContent = ` · ${summary.files} files · ${formatBytes(summary.bytes)}`;
      })
      .catch(() => {
        details.textContent = " · unreadable";
      });
  }

  const createHint = el<HTMLSpanElement>("profile-create-hint");
  if (createHint) {
    const select = el<HTMLSelectElement>("profile-new-source");
    if (select) {
      select.options[1].textContent = `copy of ${ui.activeProfile()}`;
    }
    createHint.textContent = "";
  }
}

/** Top-level app tiles, excluding the trunk (always on the board). */
async function topLevelAppNames(): Promise<string[]> {
  if (appNames) return appNames;
  const res = await fetch("/api/apps", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`could not list apps (HTTP ${res.status})`);
  const data = (await res.json()) as { apps?: Array<{ name?: unknown; parent?: unknown }> };
  appNames = (data.apps ?? [])
    .filter((app) => typeof app.name === "string" && app.name !== "trunk" && !app.parent)
    .map((app) => app.name as string);
  return appNames;
}

/** Reflect changed board exceptions immediately; boot picks them up next load. */
function publishVisibleApps(profile: string, apps: string[] | null): void {
  if (profile !== getHooks().activeProfile()) return;
  (window as unknown as { __bobProfileVisibleApps?: string[] | null }).__bobProfileVisibleApps = apps;
}

/** Checkbox list of top-level apps kept on the board ("hidden… except:"). */
async function openHiddenDialog(profile: ProfileRecord): Promise<void> {
  const dialog = el<HTMLDialogElement>("hidden-dialog");
  if (!dialog) return;
  hiddenProfile = profile.name;
  const suffix = el<HTMLElement>("hidden-profile-name");
  if (suffix) suffix.textContent = profile.name;
  const quiet = el<HTMLButtonElement>("hidden-quiet");
  if (quiet) quiet.hidden = !Array.isArray(profile.visibleApps);
  const status = el<HTMLElement>("hidden-status");
  if (status) status.textContent = "";
  const list = el<HTMLDivElement>("hidden-app-list");
  if (list) list.textContent = "loading apps…";
  const save = el<HTMLButtonElement>("hidden-save");
  if (save) save.disabled = true;
  if (!dialog.open) dialog.showModal();

  let names: string[];
  try {
    names = await topLevelAppNames();
  } catch (err) {
    if (list) list.textContent = `could not list apps: ${errorText(err)}`;
    return;
  }
  if (hiddenProfile !== profile.name || !list) return;
  if (save) save.disabled = false;
  const selected = new Set(profile.visibleApps ?? []);
  list.replaceChildren(
    ...names.map((name) => {
      const label = document.createElement("label");
      label.className = "hidden-app-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = name;
      box.checked = selected.has(name);
      label.append(box, document.createTextNode(name));
      return label;
    }),
  );
  if (!names.length) list.textContent = "no app tiles found in this workspace";
}

async function saveVisibleApps(profile: string, apps: string[] | null): Promise<void> {
  const dialog = el<HTMLDialogElement>("hidden-dialog");
  const status = el<HTMLElement>("hidden-status");
  const save = el<HTMLButtonElement>("hidden-save");
  const quiet = el<HTMLButtonElement>("hidden-quiet");
  if (save) save.disabled = true;
  if (quiet) quiet.disabled = true;
  if (status) status.textContent = "saving…";
  try {
    await setProfileVisibleApps(profile, apps);
    publishVisibleApps(profile, apps);
    getHooks().flash(
      apps === null
        ? `"${profile}" uses the trunk-only default`
        : apps.length
          ? `"${profile}" keeps ${apps.join(", ")} on the board by default`
          : `"${profile}" leaves only trunk on the board by default`,
      6000,
    );
    dialog?.close();
    await renderProfileList();
  } catch (err) {
    if (status) status.textContent = `save failed: ${errorText(err)}`;
  } finally {
    if (save) save.disabled = false;
    if (quiet) quiet.disabled = false;
  }
}

function wireHiddenDialog(): void {
  const dialog = el<HTMLDialogElement>("hidden-dialog");
  el<HTMLButtonElement>("hidden-close")?.addEventListener("click", () => dialog?.close());
  el<HTMLButtonElement>("hidden-save")?.addEventListener("click", () => {
    if (!hiddenProfile) return;
    const list = el<HTMLDivElement>("hidden-app-list");
    const checked = list
      ? [...list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map((box) => box.value)
      : [];
    void saveVisibleApps(hiddenProfile, checked);
  });
  el<HTMLButtonElement>("hidden-quiet")?.addEventListener("click", () => {
    if (hiddenProfile) void saveVisibleApps(hiddenProfile, null);
  });
}

function actionButton(
  label: string,
  onClick: () => void,
  danger = false,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (danger) button.className = "danger";
  button.addEventListener("click", onClick);
  return button;
}

function wireProfileManager(): void {
  const dialog = el<HTMLDialogElement>("profile-dialog");
  const open = el<HTMLButtonElement>("profile-manage");
  open?.addEventListener("click", () => {
    if (!dialog) return;
    void renderProfileList();
    void refreshSeedChoices();
    dialog.showModal();
  });
  el<HTMLButtonElement>("profile-close")?.addEventListener("click", () => dialog?.close());

  const form = el<HTMLFormElement>("profile-create");
  const sourceSelect = el<HTMLSelectElement>("profile-new-source");
  const seedLabel = el<HTMLElement>("profile-new-seed-label");
  const syncSourceFields = (): void => {
    const source = sourceSelect?.value ?? "blank";
    if (seedLabel) seedLabel.hidden = source !== "blank";
  };
  sourceSelect?.addEventListener("change", syncSourceFields);
  syncSourceFields();

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const ui = getHooks();
    const name = el<HTMLInputElement>("profile-new-name")?.value.trim() ?? "";
    const source = el<HTMLSelectElement>("profile-new-source")?.value ?? "blank";
    const switchNow = el<HTMLInputElement>("profile-new-switch")?.checked ?? true;
    if (!isValidProfileName(name)) {
      ui.flash("profile names use lowercase letters, digits, dot, dash or underscore", 8000);
      return;
    }
    const seedChoice = source === "blank" ? selectedSeedChoice() : null;
    if (source === "blank" && !seedChoice) {
      ui.flash("pick a seed to seed this workspace from", 8000);
      return;
    }
    void (async () => {
      const hint = el<HTMLElement>("profile-create-hint");
      const submit = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
      try {
        if (source === "duplicate") {
          await createProfile(name, { kind: "duplicate", from: await profileHandle(ui.activeProfile()) });
        } else if (seedChoice?.kind === "remote") {
          // Fetch before creating anything: a failed pull must not leave a
          // half-seeded profile behind.
          if (submit) submit.disabled = true;
          if (hint) hint.textContent = `fetching seed ${seedChoice.account}/${seedChoice.seedName}…`;
          const service = resolveSwapService(seedChoice.baseUrl);
          if (!service) throw new Error(`seed service ${seedChoice.baseUrl} is not configured`);
          const account = service.account || seedChoice.account;
          const fetched = await fetchLatestSeed(service, account, seedChoice.seedName);
          if (!fetched) throw new Error(`seed ${seedChoice.account}/${seedChoice.seedName} is unchanged`);
          const binding: SeedBinding = {
            baseUrl: service.baseUrl,
            account,
            seedName: seedChoice.seedName,
            lastVersion: {
              version: fetched.version ?? fetched.sha256.slice(0, 12),
              sha256: fetched.sha256,
              createdAt: fetched.archive.createdAt,
              checkedAt: new Date().toISOString(),
            },
          };
          if (hint) hint.textContent = `seeding ${fetched.archive.files.length} files…`;
          try {
            await createProfile(name, {
              kind: "seed",
              archive: fetched.archive,
              sha256: fetched.sha256,
              binding,
              onProgress: (done, total) => {
                setSeedProgress("profile-seed-bar", done, total);
                if (hint) hint.textContent = `seeding ${done}/${total} files…`;
              },
            });
          } finally {
            clearSeedProgress("profile-seed-bar");
          }
          if (hint) hint.textContent = "";
          ui.flash(`workspace seeded from ${account}/${seedChoice.seedName}`, 6000);
        } else {
          // The bundled snapshot: first boot overlays `/seed/workspace.json`.
          await createProfile(name, { kind: "blank" });
        }
        if (switchNow) {
          activateProfile(name);
          ui.reload();
          return;
        }
        (el<HTMLInputElement>("profile-new-name") as HTMLInputElement).value = "";
        await renderProfileList();
        renderProfileSelect();
        ui.flash(`profile "${name}" created`, 5000);
      } catch (err) {
        ui.flash(`create failed: ${errorText(err)}`, 8000);
      } finally {
        if (submit) submit.disabled = false;
        if (hint) hint.textContent = "";
      }
    })();
  });
}

// ── new-workspace seed picker ────────────────────────────────────────────

/** The bundled snapshot is a pick like any other seed, never a default. */
const SHIPPED_SEED_VALUE = "shipped";

type NewWorkspaceSeedChoice =
  | { kind: "shipped" }
  | { kind: "remote"; baseUrl: string; account: string; seedName: string };

function newOption(label: string, value: string, disabled = false): HTMLOptionElement {
  const option = document.createElement("option");
  option.textContent = label;
  option.value = value;
  if (disabled) option.disabled = true;
  return option;
}

/** `value` for a listed BobSwap seed; the parts are validated path segments. */
function seedChoiceValue(baseUrl: string, account: string, seedName: string): string {
  return `${baseUrl}|${account}|${seedName}`;
}

function selectedSeedChoice(): NewWorkspaceSeedChoice | null {
  const value = el<HTMLSelectElement>("profile-new-seed")?.value ?? "";
  if (!value) return null;
  if (value === SHIPPED_SEED_VALUE) return { kind: "shipped" };
  const [baseUrl, account, seedName] = value.split("|");
  if (!baseUrl || !account || !seedName) return null;
  return { kind: "remote", baseUrl, account, seedName };
}

/**
 * Fill the new-workspace seed picker: the bundled snapshot plus every seed
 * listed by a configured BobSwap service. Nothing is preselected — creating a
 * profile requires an explicit pick. A service that cannot list (no account or
 * read key, offline, rejected key) shows why instead of failing the dialog.
 */
async function refreshSeedChoices(): Promise<void> {
  const select = el<HTMLSelectElement>("profile-new-seed");
  if (!select) return;
  const previous = select.value;
  const placeholder = newOption("pick a seed…", "", true);
  const shipped = newOption("bundled snapshot (shipped seed)", SHIPPED_SEED_VALUE);
  const loading = newOption("loading seeds…", "", true);
  select.replaceChildren(placeholder, shipped, loading);

  const services = listSwapServices();
  const groups: HTMLOptGroupElement[] = [];
  if (services.length > 0) {
    const results = await Promise.allSettled(
      services.map(async (service) => {
        const account = service.account ?? "";
        if (!ACCOUNT_RE.test(account)) throw new Error("no valid account configured");
        if (!service.readKey) throw new Error("no read key configured — listing the shelf needs one");
        return { service, account, seeds: await listSeeds(service, account) };
      }),
    );
    results.forEach((result, index) => {
      const service = services[index];
      const group = document.createElement("optgroup");
      group.label = service.account ? `${service.baseUrl} · ${service.account}` : service.baseUrl;
      if (result.status === "fulfilled") {
        const { account, seeds } = result.value;
        if (seeds.length === 0) group.append(newOption("(no seeds published)", "", true));
        for (const seed of seeds) {
          group.append(
            newOption(
              seed.latest ? `${seed.name} · ${seed.latest}` : seed.name,
              seedChoiceValue(service.baseUrl, account, seed.name),
            ),
          );
        }
      } else {
        group.append(newOption(`(unavailable: ${errorText(result.reason)})`, "", true));
      }
      groups.push(group);
    });
  }

  select.replaceChildren(placeholder, shipped, ...groups);
  if (services.length === 0) {
    select.append(newOption("add a BobSwap service in Sync… → BobSwap… for more seeds", "", true));
  }
  // Keep the user's pick across a refresh; a vanished seed falls back to the
  // placeholder so Create stays blocked instead of silently using another seed.
  select.value = [...select.options].some((option) => option.value === previous) ? previous : "";
}

// ── seed source dialog ───────────────────────────────────────────────────

function currentProfileRecord(name: string): ProfileRecord | undefined {
  return getHooks().registry().profiles.find((profile) => profile.name === name);
}

function openSeedDialog(profile: ProfileRecord): void {
  const dialog = el<HTMLDialogElement>("seed-dialog");
  if (!dialog) return;
  seedDialogProfile = profile.name;
  seedDialogMode = "binding";
  pendingSeedCheck = null;

  setSeedDialogChrome("Seed source", profile.name);
  const seedName = el<HTMLInputElement>("seed-name");
  if (seedName) seedName.value = profile.seed?.seedName ?? "";

  const picker = el<HTMLSelectElement>("seed-service");
  fillServiceSelect(picker, profile.seed?.baseUrl);
  // Keep a binding's service visible even when its entry was removed.
  const preferred = profile.seed?.baseUrl;
  if (picker && preferred && ![...picker.options].some((option) => option.value === preferred)) {
    const option = document.createElement("option");
    option.value = preferred;
    option.textContent = `${preferred} (not configured)`;
    picker.append(option);
    picker.value = preferred;
  }
  const stored = resolveSwapService(picker?.value);
  fillServiceFields(stored);
  setSeedBindingHint(stored, profile.seed);

  setSeedStatus(profile.seed?.lastVersion ? `last pulled version: ${profile.seed.lastVersion.version}` : "");
  const apply = el<HTMLButtonElement>("seed-apply");
  if (apply) apply.hidden = true;
  const unbind = el<HTMLButtonElement>("seed-unbind");
  if (unbind) unbind.hidden = !profile.seed;
  dialog.showModal();
}

/** Open the same dialog for service/keys only (no profile binding). */
function openServiceDialog(): void {
  const dialog = el<HTMLDialogElement>("seed-dialog");
  if (!dialog) return;
  seedDialogProfile = "";
  seedDialogMode = "service";
  pendingSeedCheck = null;
  setSeedDialogChrome("BobSwap service", "");
  fillServiceFields(activeSwapService());
  setSeedStatus(
    "Services, accounts and keys are saved per browser. Profiles bind a seed name on the selected service.",
  );
  const apply = el<HTMLButtonElement>("seed-apply");
  if (apply) apply.hidden = true;
  const unbind = el<HTMLButtonElement>("seed-unbind");
  if (unbind) unbind.hidden = true;
  dialog.showModal();
}

/** Explain which service/account a binding will use, or what is missing. */
function setSeedBindingHint(service: SwapService | null, binding?: SeedBinding): void {
  const hint = el<HTMLElement>("seed-dialog-hint");
  if (!hint) return;
  const legacy = binding && service && binding.baseUrl === service.baseUrl ? binding.account : "";
  const account = service?.account || legacy || "";
  hint.textContent = !service
    ? "Add a BobSwap service first (Sync… → BobSwap…), then bind this profile to a seed."
    : !account
      ? `Set the account for ${service.baseUrl} in Sync… → BobSwap…, then bind this profile to a seed.`
      : !service.readKey
        ? `Bind this profile to a seed on ${service.baseUrl} (account ${account}). ` +
          "Public versions need no key; add a read key in Sync… → BobSwap… to list the shelf and read private versions."
        : `Bind this profile to a seed on ${service.baseUrl} (account ${account}). ` +
          "Updates appear in the toolbar; the run log and chat history are kept.";
}

/** Show/hide the binding-only fields and actions for the current dialog mode. */
function setSeedDialogChrome(title: string, profileName: string): void {
  const titleEl = el<HTMLElement>("seed-dialog-title");
  if (titleEl) titleEl.textContent = title;
  const nameEl = el<HTMLElement>("seed-profile-name");
  if (nameEl) nameEl.textContent = profileName;
  const suffix = el<HTMLElement>("seed-profile-suffix");
  if (suffix) suffix.hidden = !profileName;
  const binding = seedDialogMode === "binding";
  // Service configuration (URLs, account, keys) belongs to BobSwap….
  for (const id of [
    "seed-base-url-label",
    "seed-realtime-url-label",
    "seed-realtime-key-label",
    "seed-account-label",
    "seed-read-key-label",
    "seed-upload-key-label",
  ]) {
    const label = el<HTMLElement>(id);
    if (label) label.hidden = binding;
  }
  const serviceLabel = el<HTMLElement>("seed-service-label");
  if (serviceLabel) serviceLabel.hidden = !binding;
  const seedNameLabel = el<HTMLElement>("seed-name-label");
  if (seedNameLabel) seedNameLabel.hidden = !binding;
  for (const id of ["seed-check", "seed-publish"]) {
    const button = el<HTMLElement>(id);
    if (button) button.hidden = !binding;
  }
  const save = el<HTMLButtonElement>("seed-save");
  if (save) save.textContent = binding ? "Save seed source" : "Save service";
  const hint = el<HTMLElement>("seed-dialog-hint");
  if (hint) {
    hint.textContent = binding
      ? "Bind this profile to a seed on the configured BobSwap service. Updates appear in the toolbar; the run log and chat history are kept."
      : "Configure a BobSwap service once (URL, account, keys), then either bind a profile to a seed or use Send/Receive.";
  }
}

function setSeedStatus(text: string): void {
  const status = el<HTMLDivElement>("seed-status");
  if (status) status.textContent = text;
}

/** Persist the service/keys fields (service-only mode). */
function saveServiceFields(): SwapService | null {
  const service = serviceFromSeedFields();
  if (!service) {
    setSeedStatus("a service URL is required");
    return null;
  }
  return saveSwapService(service);
}

/** Validate the seed source form into a binding (no persistence). */
function seedBindingFromFields(profileName: string): SeedBinding | null {
  const seedName = el<HTMLInputElement>("seed-name")?.value.trim() ?? "";
  if (!isValidSeedName(seedName)) {
    setSeedStatus("seed names use lowercase letters, digits, dot, dash or underscore");
    return null;
  }
  const existing = currentProfileRecord(profileName)?.seed;
  // The service owns the account and keys; a binding only names the seed.
  const selected = el<HTMLSelectElement>("seed-service")?.value ?? "";
  const service = selected
    ? resolveSwapService(selected)
    : existing
      ? resolveSwapService(existing.baseUrl)
      : activeSwapService();
  if (!service) {
    setSeedStatus("add a configured BobSwap service first (Sync… → BobSwap…)");
    return null;
  }
  // Only carry a legacy account over when the binding stays on the same
  // service; a different service must declare its own account.
  const account =
    service.account || (existing && existing.baseUrl === service.baseUrl ? existing.account : "");
  if (!ACCOUNT_RE.test(account)) {
    setSeedStatus("set the account in the BobSwap service settings first (Sync… → BobSwap…)");
    return null;
  }
  return {
    baseUrl: service.baseUrl,
    account,
    seedName,
    lastVersion: existing?.lastVersion,
  };
}

/** Persist the seed source form as this profile's binding. */
async function saveSeedBinding(): Promise<SeedBinding | null> {
  if (!seedDialogProfile) return null;
  const ui = getHooks();
  const binding = seedBindingFromFields(seedDialogProfile);
  if (!binding) return null;
  await setSeedBinding(seedDialogProfile, binding);
  await ui.refreshRegistry();
  return binding;
}

async function checkSeedNow(): Promise<void> {
  const ui = getHooks();
  if (!seedDialogProfile) return;
  const binding = seedBindingFromFields(seedDialogProfile);
  if (!binding) return;
  // Checking is a read: only the typed fields matter. A storage backend that
  // refuses the registry write (Gecko's wedged OPFS reports a bare
  // `UnknownError: Unknown failure`) must not block it — warn, check anyway,
  // and let Apply retry the save.
  let persisted = true;
  try {
    await setSeedBinding(seedDialogProfile, binding);
    await ui.refreshRegistry();
  } catch (err) {
    persisted = false;
    setSeedStatus(`binding not saved: ${errorText(err)} — checking the fields as typed…`);
  }
  const notSaved = persisted ? "" : " · binding not saved";
  const service = resolveSwapService(binding.baseUrl);
  if (!service) {
    setSeedStatus(`service configuration is missing — add it in Sync… → BobSwap…${notSaved}`);
    return;
  }
  const account = service.account || binding.account;
  setSeedStatus("checking…");
  try {
    const probe = await probeLatestSeed(
      service,
      account,
      binding.seedName,
      binding.lastVersion?.sha256,
    );
    if (!probe) {
      pendingSeedCheck = null;
      const apply = el<HTMLButtonElement>("seed-apply");
      if (apply) apply.hidden = true;
      setSeedStatus(`up to date${notSaved}`);
      return;
    }
    const meta = probe.meta;
    const version = probe.version ?? meta.seed_id_and_version;
    const last = binding.lastVersion;
    const newer = !last || (meta.sha256 && meta.sha256 !== last.sha256) || (meta.createdAt && meta.createdAt !== last.createdAt);
    setSeedStatus(
      `latest: ${version ?? "(unlabelled)"} · ${new Date(meta.createdAt).toLocaleString()}` +
        (meta.sha256 ? ` · ${meta.sha256.slice(0, 12)}…` : "") +
        (newer ? " — newer than this profile" : " — up to date") +
        notSaved,
    );
    pendingSeedCheck = newer ? { meta, version } : null;
    const apply = el<HTMLButtonElement>("seed-apply");
    if (apply) apply.hidden = !newer;
    if (newer) ui.flash(`seed update available: ${binding.seedName}`, 6000);
  } catch (err) {
    setSeedStatus(`check failed: ${errorText(err)}${notSaved}`);
  }
}

async function applyCheckedSeed(): Promise<void> {
  const ui = getHooks();
  if (!pendingSeedCheck || !seedDialogProfile) return;
  let binding: SeedBinding | null = null;
  try {
    binding = await saveSeedBinding();
  } catch (err) {
    setSeedStatus(`save failed: ${errorText(err)}`);
    return;
  }
  if (!binding) return;
  const dialog = el<HTMLDialogElement>("seed-dialog");
  dialog?.close();
  try {
    await ui.applySeedUpdate(binding, pendingSeedCheck.meta, pendingSeedCheck.version);
  } catch (err) {
    ui.flash(`update failed: ${errorText(err)}`, 10_000);
  }
}

async function publishProfile(profile: ProfileRecord): Promise<void> {
  const ui = getHooks();
  let binding: SeedBinding | null = null;
  try {
    binding =
      profile.name === seedDialogProfile ? await saveSeedBinding() : (profile.seed ?? null);
  } catch (err) {
    setSeedStatus(`save failed: ${errorText(err)}`);
    ui.flash(`could not save the seed source: ${errorText(err)}`, 10_000);
    return;
  }
  if (!binding) {
    ui.flash("set a seed source for this profile first", 8000);
    return;
  }
  const service = resolveSwapService(binding.baseUrl);
  if (!service) {
    ui.flash("this seed's BobSwap service is not configured — add it in Sync… → BobSwap…", 8000);
    return;
  }
  if (!service.uploadKey) {
    ui.flash("this service has no upload key — add one in Sync… → BobSwap…", 8000);
    return;
  }
  const account = service.account || binding.account;
  if (!confirm(`Publish profile "${profile.name}" to ${account}/${binding.seedName}?`)) return;
  try {
    ui.flash("building archive…", 5000);
    const archive =
      profile.name === ui.activeProfile()
        ? await ui.buildActiveArchive()
        : await buildWorkspaceArchive(await profileHandle(profile.name));
    const published = await publishSeed(service, account, binding.seedName, archive);
    await recordSeedVersion(profile.name, {
      version: published.version,
      sha256: published.sha256,
      createdAt: published.createdAt,
      checkedAt: new Date().toISOString(),
    });
    await ui.refreshRegistry();
    setSeedStatus(`published ${published.version} (${archive.files.length} files, ${formatBytes(published.size)})`);
    ui.flash(`published ${binding.seedName} · ${published.version}`, 8000);
    renderProfileSelect();
  } catch (err) {
    setSeedStatus(`publish failed: ${errorText(err)}`);
    ui.flash(`publish failed: ${errorText(err)}`, 10_000);
  }
}

function wireSeedDialog(): void {
  const dialog = el<HTMLDialogElement>("seed-dialog");
  el<HTMLButtonElement>("seed-close")?.addEventListener("click", () => dialog?.close());
  el<HTMLButtonElement>("swap-settings")?.addEventListener("click", () => openServiceDialog());
  el<HTMLButtonElement>("seed-save")?.addEventListener("click", () => {
    if (seedDialogMode === "service") {
      const saved = saveServiceFields();
      if (!saved) return;
      setSeedStatus(`service saved: ${saved.baseUrl}`);
      getHooks().flash("BobSwap service saved", 5000);
      fillServiceSelect(el<HTMLSelectElement>("share-service"));
      fillServiceSelect(el<HTMLSelectElement>("recv-service"));
      return;
    }
    void saveSeedBinding()
      .then((binding) => {
        if (binding) {
          setSeedStatus("seed source saved");
          getHooks().flash("seed source saved", 5000);
          void renderProfileList();
        }
      })
      .catch((err) => setSeedStatus(`save failed: ${errorText(err)}`));
  });
  el<HTMLButtonElement>("seed-check")?.addEventListener("click", () => void checkSeedNow());
  el<HTMLSelectElement>("seed-service")?.addEventListener("change", () => {
    const service = resolveSwapService(el<HTMLSelectElement>("seed-service")?.value);
    if (service) fillServiceFields(service);
    setSeedBindingHint(service, currentProfileRecord(seedDialogProfile)?.seed);
  });
  el<HTMLButtonElement>("seed-apply")?.addEventListener("click", () => void applyCheckedSeed());
  el<HTMLButtonElement>("seed-unbind")?.addEventListener("click", () => {
    if (!seedDialogProfile) return;
    void setSeedBinding(seedDialogProfile, null)
      .then(() => {
        setSeedStatus("seed source removed");
        pendingSeedCheck = null;
        const apply = el<HTMLButtonElement>("seed-apply");
        if (apply) apply.hidden = true;
        void renderProfileList();
      })
      .catch((err) => setSeedStatus(`unbind failed: ${errorText(err)}`));
  });
  el<HTMLButtonElement>("seed-publish")?.addEventListener("click", () => {
    const record = currentProfileRecord(seedDialogProfile);
    if (record) void publishProfile(record);
  });
}

// ── share (send) ─────────────────────────────────────────────────────────

function fillServiceSelect(select: HTMLSelectElement | null, preferred?: string): void {
  if (!select) return;
  const services = listSwapServices();
  const options = services.map((service) => {
    const option = document.createElement("option");
    option.value = service.baseUrl;
    option.textContent = service.baseUrl;
    return option;
  });
  if (!services.some((service) => service.baseUrl === DEFAULT_SWAP_SERVICE_URL)) {
    const option = document.createElement("option");
    option.value = DEFAULT_SWAP_SERVICE_URL;
    option.textContent = `${DEFAULT_SWAP_SERVICE_URL} (default)`;
    options.push(option);
  }
  select.replaceChildren(...options);
  const active = preferred || loadSwapStore().active;
  if (active && options.some((option) => option.value === active)) {
    select.value = active;
  } else if (services[0]) {
    select.value = services[0].baseUrl;
  } else {
    select.value = DEFAULT_SWAP_SERVICE_URL;
  }
}

/** Show `done` of `total` files written on a seed `<progress>` bar. */
export function setSeedProgress(barId: string, done: number, total: number): void {
  const bar = el<HTMLProgressElement>(barId);
  if (!bar) return;
  bar.hidden = false;
  bar.max = Math.max(1, total);
  bar.value = Math.min(done, bar.max);
}

/** Hide a seed progress bar once an apply finishes — success or failure. */
export function clearSeedProgress(barId: string): void {
  const bar = el<HTMLProgressElement>(barId);
  if (!bar) return;
  bar.hidden = true;
  bar.value = 0;
}

function setShareProgress(progress: RelayProgress): void {
  const bar = el<HTMLProgressElement>("share-bar");
  if (bar) {
    bar.max = progress.total || 1;
    bar.value = progress.sent || 0;
  }
  const line = el<HTMLDivElement>("share-progress");
  if (line) {
    const pct = progress.total ? Math.round((progress.sent / progress.total) * 100) : 0;
    line.textContent = `${progress.message}${progress.total ? ` · ${pct}%` : ""}`;
  }
  if (progress.check) {
    const check = el<HTMLElement>("share-check");
    if (check) check.textContent = progress.check;
  }
  if (progress.code) {
    const code = el<HTMLElement>("share-code");
    if (code) code.textContent = progress.code;
  }
}

async function startShare(): Promise<void> {
  const ui = getHooks();
  const selected = el<HTMLSelectElement>("share-service")?.value ?? "";
  const service = resolveSwapService(selected);
  if (!service) {
    ui.flash("add a BobSwap service first (BobSwap…)", 8000);
    return;
  }
  const nameInput = el<HTMLInputElement>("share-device-name");
  if (nameInput?.value.trim()) saveDeviceName(nameInput.value);
  const current = await loadOrCreateDevice();

  const archive = await ui.buildActiveArchive();
  const proceed = confirm(
    `Share "${ui.activeProfile()}" (${archive.files.length} files) to another device?\n\n` +
      "Nothing is stored on the service. This tab must stay open until the other " +
      "device has joined and received the copy.",
  );
  if (!proceed) return;

  shareAbort?.abort();
  shareAbort = new AbortController();
  const offer = el<HTMLDivElement>("share-offer");
  if (offer) offer.hidden = false;
  const channel = el<HTMLElement>("share-channel");
  if (channel) channel.textContent = "";
  const start = el<HTMLButtonElement>("share-start");
  if (start) start.disabled = true;

  try {
    await sendWorkspace({
      service,
      archive,
      device: current,
      signal: shareAbort.signal,
      onChannel: (info: RelayChannelInfo) => {
        const code = el<HTMLElement>("share-code");
        if (code) code.textContent = info.code;
        const check = el<HTMLElement>("share-check");
        if (check) check.textContent = info.visualCheck ?? "—";
        if (channel) channel.textContent = info.channelId;
      },
      onProgress: setShareProgress,
    });
    ui.flash("workspace delivered", 8000);
  } catch (err) {
    setShareProgress({
      phase: "error",
      sent: 0,
      total: 0,
      message: errorText(err),
    });
    if (!/cancel/i.test(errorText(err))) ui.flash(`share failed: ${errorText(err)}`, 10_000);
  } finally {
    const startButton = el<HTMLButtonElement>("share-start");
    if (startButton) startButton.disabled = false;
  }
}

function wireShareDialog(): void {
  const dialog = el<HTMLDialogElement>("share-dialog");
  el<HTMLButtonElement>("share-send")?.addEventListener("click", () => {
    if (!dialog) return;
    fillServiceSelect(el<HTMLSelectElement>("share-service"));
    void loadOrCreateDevice().then((device) => {
      const name = el<HTMLInputElement>("share-device-name");
      if (name) name.value = device.name;
    });
    const offer = el<HTMLDivElement>("share-offer");
    if (offer) offer.hidden = true;
    setShareProgress({ phase: "offered", sent: 0, total: 0, message: "ready" });
    dialog.showModal();
  });
  el<HTMLButtonElement>("share-start")?.addEventListener("click", () => void startShare());
  el<HTMLButtonElement>("share-cancel")?.addEventListener("click", () => {
    shareAbort?.abort();
    setShareProgress({ phase: "error", sent: 0, total: 0, message: "cancelled" });
  });
  el<HTMLButtonElement>("share-close")?.addEventListener("click", () => {
    shareAbort?.abort();
    dialog?.close();
  });
  dialog?.addEventListener("close", () => shareAbort?.abort());
}

// ── receive ──────────────────────────────────────────────────────────────

function renderReceiveTargets(): void {
  const select = el<HTMLSelectElement>("recv-target");
  if (!select) return;
  const ui = getHooks();
  const wrap = el<HTMLElement>("recv-new-wrap");
  const registry = ui.registry();
  const current = `current:${ui.activeProfile()}`;
  const options: HTMLOptionElement[] = [];
  for (const profile of registry.profiles) {
    const option = document.createElement("option");
    option.value = profile.name === ui.activeProfile() ? current : `profile:${profile.name}`;
    option.textContent =
      profile.name === ui.activeProfile()
        ? `current profile (${profile.name})`
        : `existing profile (${profile.name})`;
    options.push(option);
  }
  const fresh = document.createElement("option");
  fresh.value = "new";
  fresh.textContent = "as a new profile…";
  options.push(fresh);
  select.replaceChildren(...options);
  select.value = current;
  if (wrap) wrap.hidden = select.value !== "new";
}

async function startReceive(): Promise<void> {
  const ui = getHooks();
  const selected = el<HTMLSelectElement>("recv-service")?.value ?? "";
  const service = resolveSwapService(selected);
  const channelId = el<HTMLInputElement>("recv-channel")?.value.trim() ?? "";
  const code = el<HTMLInputElement>("recv-code")?.value.trim() ?? "";
  if (!service) {
    ui.flash("add a BobSwap service first (BobSwap…)", 8000);
    return;
  }
  if (!channelId || !/^\d{6}$/.test(code)) {
    setReceiveStatus("enter the channel id and the 6-digit pairing code");
    return;
  }
  const target = el<HTMLSelectElement>("recv-target")?.value ?? "new";
  const newName = el<HTMLInputElement>("recv-new-name")?.value.trim() ?? "";
  if (target === "new" && !isValidProfileName(newName)) {
    setReceiveStatus("new profile names use lowercase letters, digits, dot, dash or underscore");
    return;
  }

  const device = await loadOrCreateDevice();
  receiveAbort?.abort();
  receiveAbort = new AbortController();
  const join = el<HTMLButtonElement>("recv-join");
  if (join) join.disabled = true;

  try {
    setReceiveStatus("pairing…");
    const received = await receiveWorkspace({
      service,
      channelId,
      code,
      device,
      signal: receiveAbort.signal,
      onProgress: (progress) => {
        const bar = el<HTMLProgressElement>("recv-bar");
        if (bar) {
          bar.max = progress.total || 1;
          bar.value = progress.sent || 0;
        }
        setReceiveStatus(
          `pairing check ${progress.check ?? "—"} · ${progress.message}` +
            (progress.peer ? ` · from ${progress.peer}` : ""),
        );
      },
    });

    const archive = validateWorkspaceArchive(received.archive);
    const profileName = target.startsWith("current:")
      ? ui.activeProfile()
      : target.slice("profile:".length);
    if (target === "new") {
      await createProfile(newName);
    }
    const targetName = target === "new" ? newName : profileName;
    setReceiveStatus("importing…");
    const written = await ui.importInto(targetName, archive);

    ui.flash(
      `received ${written} files from ${received.ownerName} into "${targetName}" ` +
        `(check ${received.visualCheck ?? "—"})`,
      10_000,
    );
    activateProfile(targetName);
    ui.reload();
  } catch (err) {
    setReceiveStatus(`receive failed: ${errorText(err)}`);
    if (!/cancel/i.test(errorText(err))) ui.flash(`receive failed: ${errorText(err)}`, 10_000);
  } finally {
    const button = el<HTMLButtonElement>("recv-join");
    if (button) button.disabled = false;
  }
}

function setReceiveStatus(text: string): void {
  const status = el<HTMLDivElement>("recv-status");
  if (status) status.textContent = text;
}

function wireReceiveDialog(): void {
  const dialog = el<HTMLDialogElement>("receive-dialog");
  const open = (): void => {
    if (!dialog) return;
    fillServiceSelect(el<HTMLSelectElement>("recv-service"));
    renderReceiveTargets();
    dialog.showModal();
  };
  el<HTMLButtonElement>("share-receive")?.addEventListener("click", open);
  el<HTMLSelectElement>("recv-target")?.addEventListener("change", () => {
    const wrap = el<HTMLElement>("recv-new-wrap");
    const select = el<HTMLSelectElement>("recv-target");
    if (wrap && select) wrap.hidden = select.value !== "new";
  });
  el<HTMLButtonElement>("recv-join")?.addEventListener("click", () => void startReceive());
  el<HTMLButtonElement>("recv-cancel")?.addEventListener("click", () => {
    receiveAbort?.abort();
    setReceiveStatus("cancelled");
  });
  el<HTMLButtonElement>("recv-close")?.addEventListener("click", () => {
    receiveAbort?.abort();
    dialog?.close();
  });
  dialog?.addEventListener("close", () => receiveAbort?.abort());
}

// ── sync menu (collapsed toolbar controls) ───────────────────────────────

/**
 * The toolbar's transfer/BobSwap controls live in `#sync-dialog`.
 * Closing it on a launcher click keeps native dialogs from stacking; the
 * launcher's own click handler then opens its dialog in the same gesture.
 */
function wireSyncDialog(): void {
  const dialog = el<HTMLDialogElement>("sync-dialog");
  if (!dialog) return;
  el<HTMLButtonElement>("sync-menu")?.addEventListener("click", () => dialog.showModal());
  el<HTMLButtonElement>("sync-close")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLButtonElement && target.id !== "sync-close") dialog.close();
    },
    true,
  );
}

// ── browser automation launcher ──────────────────────────────────────────

type LauncherOs = "windows" | "mac" | "linux";

/** Preselect the tab for the platform this page is running on. */
function detectLauncherOs(): LauncherOs {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = `${nav.userAgentData?.platform ?? ""} ${navigator.userAgent}`;
  if (/windows|win32|win64/i.test(platform)) return "windows";
  if (/mac/i.test(platform) && !/iphone|ipad|ipod/i.test(platform)) return "mac";
  return "linux";
}

/** The one-liner a user copies; the served script does the rest. */
function launcherCommand(os: LauncherOs, appUrl: string): string {
  const scripts = `${location.origin}/scripts`;
  if (os === "windows") {
    return `$env:BOB_APP_URL='${appUrl}'; irm ${scripts}/bob-browser.ps1 | iex`;
  }
  return `curl -fsSL ${scripts}/bob-browser.sh | sh -s -- ${appUrl}`;
}

/** "Connect browser…" in the Sync dialog: copy a launcher command per OS. */
function wireBrowserDialog(): void {
  const dialog = el<HTMLDialogElement>("browser-dialog");
  const open = el<HTMLButtonElement>("browser-menu");
  if (!dialog || !open) return;

  const commandEl = el<HTMLElement>("browser-command");
  const statusEl = el<HTMLElement>("browser-status");
  const shellEl = el<HTMLElement>("browser-shell");
  const appInput = el<HTMLInputElement>("browser-app-url");
  const download = el<HTMLAnchorElement>("browser-download");
  const preview = el<HTMLElement>("browser-script");
  const tabs = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".browser-tab"));

  let os: LauncherOs = detectLauncherOs();
  let previewed: LauncherOs | null = null;

  const setStatus = (text: string): void => {
    if (statusEl) statusEl.textContent = text;
  };
  const rawAppUrl = (): string => (appInput?.value.trim() || location.origin).replace(/\/+$/, "");
  /** The value is interpolated into shell commands: keep it a bare http(s) URL. */
  const appUrl = (): string | null => {
    const url = rawAppUrl();
    return /^https?:\/\/[^\s'"]+$/i.test(url) ? url : null;
  };
  const scriptFile = (): string => (os === "windows" ? "bob-browser.ps1" : "bob-browser.sh");

  const loadPreview = async (): Promise<void> => {
    if (!preview || previewed === os) return;
    previewed = os;
    const file = scriptFile();
    preview.textContent = "loading…";
    try {
      const res = await fetch(`${location.origin}/scripts/${file}`, { cache: "no-store" });
      preview.textContent = res.ok ? await res.text() : `could not load ${file} (HTTP ${res.status})`;
    } catch (err) {
      preview.textContent = `could not load ${file}: ${errorText(err)}`;
    }
  };

  const render = (): void => {
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.os === os));
    if (shellEl) shellEl.textContent = os === "windows" ? "PowerShell" : "Terminal";
    const url = appUrl();
    if (commandEl) commandEl.textContent = url ? launcherCommand(os, url) : "";
    if (download) {
      const file = scriptFile();
      download.setAttribute("href", `${location.origin}/scripts/${file}`);
      download.setAttribute("download", file);
      download.textContent = `Download ${file} instead`;
    }
    if (!url) setStatus("app URL must start with http(s):// and contain no spaces or quotes");
    void loadPreview();
  };

  const copy = async (): Promise<void> => {
    const url = appUrl();
    if (!url) {
      setStatus("app URL must start with http(s):// and contain no spaces or quotes");
      return;
    }
    const text = launcherCommand(os, url);
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setStatus(`copied — paste it into ${os === "windows" ? "PowerShell" : "a terminal"}`);
      getHooks().flash("command copied", 4000);
    } catch {
      if (!commandEl) return;
      const range = document.createRange();
      range.selectNodeContents(commandEl);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      setStatus("copy failed — the command is selected, press Ctrl/Cmd+C");
    }
  };

  open.addEventListener("click", () => {
    os = detectLauncherOs();
    previewed = null;
    if (appInput) appInput.value = location.origin;
    setStatus("");
    render();
    dialog.showModal();
  });
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      os = (tab.dataset.os as LauncherOs | undefined) ?? os;
      previewed = null;
      setStatus("");
      render();
    });
  }
  appInput?.addEventListener("input", () => render());
  el<HTMLButtonElement>("browser-copy")?.addEventListener("click", () => void copy());
  el<HTMLButtonElement>("browser-close")?.addEventListener("click", () => dialog.close());
}

// ── entry point ──────────────────────────────────────────────────────────

export function wireProfileUi(profileHooks: ProfileUiHooks): void {
  hooks = profileHooks;
  renderProfileSelect();

  el<HTMLSelectElement>("profile-select")?.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    activateProfile(select.value);
    getHooks().reload();
  });

  wireProfileManager();
  wireHiddenDialog();
  wireSeedDialog();
  wireShareDialog();
  wireReceiveDialog();
  wireBrowserDialog();
  wireSyncDialog();

  // Keep the receive dialog able to target the active profile after changes.
  const dialog = el<HTMLDialogElement>("profile-dialog");
  dialog?.addEventListener("close", () => renderProfileSelect());
}
