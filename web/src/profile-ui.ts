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
  setSeedBinding,
  type ProfileRecord,
  type ProfileRegistry,
  type SeedBinding,
} from "./profiles";
import {
  activeSwapService,
  fetchLatestSeed,
  fetchLatestSeedMeta,
  listSwapServices,
  loadSwapStore,
  publishSeed,
  receiveWorkspace,
  saveSwapService,
  sendWorkspace,
  serviceFor,
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

export interface ProfileUiHooks {
  storage(): "browser" | "desktop";
  activeProfile(): string;
  registry(): ProfileRegistry;
  flash(text: string, ms?: number): void;
  reload(): void;
  refreshRegistry(): Promise<ProfileRegistry>;
  /** Pull a binding's newest seed into the ACTIVE profile (banner path). */
  applySeedUpdate(binding: SeedBinding, meta: RemoteSeedMeta, version?: string): Promise<void>;
  /** Archive whatever workspace BOB currently operates on. */
  buildActiveArchive(): Promise<WorkspaceArchive>;
  /** Merge into a profile (browser) or the single desktop workspace (null). */
  importInto(target: string | null, archive: WorkspaceArchive): Promise<number>;
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
    readKey: el<HTMLInputElement>("seed-read-key")?.value.trim() || undefined,
    uploadKey: el<HTMLInputElement>("seed-upload-key")?.value.trim() || undefined,
  };
}

function fillServiceFields(service: SwapService | null): void {
  const set = (id: string, value: string | undefined): void => {
    const input = el<HTMLInputElement>(id);
    if (input) input.value = value ?? "";
  };
  set("seed-base-url", service?.baseUrl);
  set("seed-realtime-url", service?.realtimeUrl);
  set("seed-realtime-key", service?.realtimeKey);
  set("seed-read-key", service?.readKey);
  set("seed-upload-key", service?.uploadKey);
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
      option.textContent = profile.name === DEFAULT_PROFILE ? "default" : profile.name;
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

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const isActive = profile.name === ui.activeProfile();
    if (!isActive) {
      actions.append(
        actionButton("Switch", () => {
          activateProfile(profile.name);
          ui.reload();
        }),
      );
    }

    actions.append(
      actionButton("Seed…", () => void openSeedDialog(profile)),
      actionButton("Publish…", () => void publishProfile(profile)),
    );
    if (profile.name !== DEFAULT_PROFILE && !isActive) {
      actions.append(
        actionButton("Delete", () => {
          if (!confirm(`Delete profile "${profile.name}" and its workspace from this browser?`)) return;
          void deleteProfile(profile.name)
            .then(() => renderProfileList())
            .catch((err) => ui.flash(`delete failed: ${errorText(err)}`, 8000));
        }, true),
      );
    }

    row.append(info, actions);
    list.append(row);

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
    dialog.showModal();
  });
  el<HTMLButtonElement>("profile-close")?.addEventListener("click", () => dialog?.close());

  const form = el<HTMLFormElement>("profile-create");
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
    void (async () => {
      try {
        const duplicate =
          source === "duplicate"
            ? { kind: "duplicate" as const, from: await profileHandle(ui.activeProfile()) }
            : { kind: "blank" as const };
        await createProfile(name, duplicate);
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
      }
    })();
  });
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
  const account = el<HTMLInputElement>("seed-account");
  const seedName = el<HTMLInputElement>("seed-name");
  if (account) account.value = profile.seed?.account ?? "";
  if (seedName) seedName.value = profile.seed?.seedName ?? "";

  const stored = profile.seed ? serviceFor(profile.seed.baseUrl) : activeSwapService();
  fillServiceFields(stored ?? (profile.seed ? { baseUrl: profile.seed.baseUrl } : null));

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
    "Services are saved per browser. A profile additionally binds an account + seed name.",
  );
  const apply = el<HTMLButtonElement>("seed-apply");
  if (apply) apply.hidden = true;
  const unbind = el<HTMLButtonElement>("seed-unbind");
  if (unbind) unbind.hidden = true;
  dialog.showModal();
}

/** Show/hide the binding-only fields and actions for the current dialog mode. */
function setSeedDialogChrome(title: string, profileName: string): void {
  const titleEl = el<HTMLElement>("seed-dialog-title");
  if (titleEl) titleEl.textContent = title;
  const nameEl = el<HTMLElement>("seed-profile-name");
  if (nameEl) nameEl.textContent = profileName;
  const binding = seedDialogMode === "binding";
  for (const id of ["seed-account-label", "seed-name-label"]) {
    const label = el<HTMLElement>(id);
    if (label) label.hidden = !binding;
  }
  for (const id of ["seed-check", "seed-publish"]) {
    const button = el<HTMLElement>(id);
    if (button) button.hidden = !binding;
  }
  const hint = el<HTMLElement>("seed-dialog-hint");
  if (hint) {
    hint.textContent = binding
      ? "Bind this profile to a seed on a BobSwap service. Updates appear in the toolbar; the run log and chat history are kept."
      : "Add a BobSwap service once, then either bind a profile to a seed or use Send/Receive.";
  }
}

function setSeedStatus(text: string): void {
  const status = el<HTMLDivElement>("seed-status");
  if (status) status.textContent = text;
}

/** Persist the service/keys fields (shared by binding and service-only mode). */
function saveServiceFields(): SwapService | null {
  const service = serviceFromSeedFields();
  if (!service) {
    setSeedStatus("a service URL is required");
    return null;
  }
  return saveSwapService(service);
}

/** Persist the seed source form as this profile's binding. */
async function saveSeedBinding(): Promise<SeedBinding | null> {
  if (!seedDialogProfile) return null;
  const ui = getHooks();
  const account = el<HTMLInputElement>("seed-account")?.value.trim() ?? "";
  const seedName = el<HTMLInputElement>("seed-name")?.value.trim() ?? "";
  if (!ACCOUNT_RE.test(account)) {
    setSeedStatus("account names use lowercase letters, digits, dot, dash or underscore");
    return null;
  }
  if (!isValidSeedName(seedName)) {
    setSeedStatus("seed names use lowercase letters, digits, dot, dash or underscore");
    return null;
  }
  const saved = saveServiceFields();
  if (!saved) return null;
  const existing = currentProfileRecord(seedDialogProfile)?.seed;
  const binding: SeedBinding = {
    baseUrl: saved.baseUrl,
    account,
    seedName,
    lastVersion: existing?.lastVersion,
  };
  await setSeedBinding(seedDialogProfile, binding);
  await ui.refreshRegistry();
  return binding;
}

async function checkSeedNow(): Promise<void> {
  const ui = getHooks();
  const binding = await saveSeedBinding();
  if (!binding) return;
  const service = serviceFor(binding.baseUrl);
  if (!service) {
    setSeedStatus("service configuration is missing");
    return;
  }
  setSeedStatus("checking…");
  try {
    const meta = await fetchLatestSeedMeta(service, binding.account, binding.seedName);
    if (!meta) {
      setSeedStatus("seed not found (or the read key is wrong)");
      return;
    }
    const version = meta.seed_id_and_version;
    const last = binding.lastVersion;
    const newer = !last || (meta.sha256 && meta.sha256 !== last.sha256) || (meta.createdAt && meta.createdAt !== last.createdAt);
    setSeedStatus(
      `latest: ${version ?? "(unlabelled)"} · ${new Date(meta.createdAt).toLocaleString()}` +
        (meta.sha256 ? ` · ${meta.sha256.slice(0, 12)}…` : "") +
        (newer ? " — newer than this profile" : " — up to date"),
    );
    pendingSeedCheck = newer ? { meta, version } : null;
    const apply = el<HTMLButtonElement>("seed-apply");
    if (apply) apply.hidden = !newer;
    if (newer) ui.flash(`seed update available: ${binding.seedName}`, 6000);
  } catch (err) {
    setSeedStatus(`check failed: ${errorText(err)}`);
  }
}

async function applyCheckedSeed(): Promise<void> {
  const ui = getHooks();
  if (!pendingSeedCheck || !seedDialogProfile) return;
  const binding = await saveSeedBinding();
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
  const binding =
    profile.name === seedDialogProfile ? await saveSeedBinding() : profile.seed ?? null;
  if (!binding) {
    ui.flash("set a seed source for this profile first", 8000);
    return;
  }
  const service = serviceFor(binding.baseUrl);
  if (!service?.uploadKey) {
    ui.flash("this service has no upload key — add one in the seed dialog", 8000);
    return;
  }
  if (!confirm(`Publish profile "${profile.name}" to ${binding.account}/${binding.seedName}?`)) return;
  try {
    ui.flash("building archive…", 5000);
    const archive =
      ui.storage() === "desktop" || profile.name === ui.activeProfile()
        ? await ui.buildActiveArchive()
        : await buildWorkspaceArchive(await profileHandle(profile.name));
    const published = await publishSeed(service, binding.account, binding.seedName, archive);
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
  select.replaceChildren(
    ...services.map((service) => {
      const option = document.createElement("option");
      option.value = service.baseUrl;
      option.textContent = service.baseUrl;
      return option;
    }),
  );
  const active = preferred || loadSwapStore().active;
  if (active && services.some((service) => service.baseUrl === active)) {
    select.value = active;
  } else if (services[0]) {
    select.value = services[0].baseUrl;
  }
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
  const services = listSwapServices();
  const selected = el<HTMLSelectElement>("share-service")?.value ?? "";
  const service = services.find((entry) => entry.baseUrl === selected);
  if (!service) {
    ui.flash("add a BobSwap service first (Profiles → Seed…)", 8000);
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
  if (ui.storage() === "desktop") {
    const only = document.createElement("option");
    only.value = "desktop";
    only.textContent = "this desktop workspace";
    select.replaceChildren(only);
    select.value = "desktop";
    if (wrap) wrap.hidden = true;
    return;
  }
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
  const services = listSwapServices();
  const selected = el<HTMLSelectElement>("recv-service")?.value ?? "";
  const service = services.find((entry) => entry.baseUrl === selected);
  const channelId = el<HTMLInputElement>("recv-channel")?.value.trim() ?? "";
  const code = el<HTMLInputElement>("recv-code")?.value.trim() ?? "";
  if (!service) {
    ui.flash("add a BobSwap service first (Profiles → Seed…)", 8000);
    return;
  }
  if (!channelId || !/^\d{6}$/.test(code)) {
    setReceiveStatus("enter the channel id and the 6-digit pairing code");
    return;
  }
  const target = el<HTMLSelectElement>("recv-target")?.value ?? "new";
  const newName = el<HTMLInputElement>("recv-new-name")?.value.trim() ?? "";
  const desktop = ui.storage() === "desktop";
  if (!desktop && target === "new" && !isValidProfileName(newName)) {
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
    let profileName: string | null = null;
    if (desktop) {
      setReceiveStatus("importing into this desktop workspace…");
    } else {
      profileName = target.startsWith("current:") ? ui.activeProfile() : target.slice("profile:".length);
      if (target === "new") {
        await createProfile(newName);
        profileName = newName;
      }
      setReceiveStatus("importing…");
    }
    const written = await ui.importInto(profileName, archive);

    ui.flash(
      `received ${written} files from ${received.ownerName} into ` +
        (profileName ? `"${profileName}"` : "this workspace") +
        ` (check ${received.visualCheck ?? "—"})`,
      10_000,
    );
    if (profileName) activateProfile(profileName);
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

  // A share link can carry ?recv=<channel_id>&code=<digits>; open the dialog
  // prefilled so the phone only has to tap the link.
  const params = new URLSearchParams(location.search);
  const channel = params.get("recv");
  const code = params.get("code") ?? "";
  if (channel && el<HTMLInputElement>("recv-channel")) {
    const channelInput = el<HTMLInputElement>("recv-channel");
    if (channelInput) channelInput.value = channel;
    if (/^\d{6}$/.test(code)) {
      const codeInput = el<HTMLInputElement>("recv-code");
      if (codeInput) codeInput.value = code;
    }
    open();
  }
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
  wireSeedDialog();
  wireShareDialog();
  wireReceiveDialog();

  // Keep the receive dialog able to target the active profile after changes.
  const dialog = el<HTMLDialogElement>("profile-dialog");
  dialog?.addEventListener("close", () => renderProfileSelect());
}
