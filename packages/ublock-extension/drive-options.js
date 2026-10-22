const runtime = (globalThis.browser ?? chrome).runtime;
const status = document.getElementById("status");
const enabled = document.getElementById("enabled");
async function send(what, data = {}) {
  const reply = await runtime.sendMessage({ what: `drive:${what}`, ...data });
  if (!reply || reply.error)
    throw new Error(reply?.error ?? "Extension indisponible");
  return reply.result;
}
async function action(fn) {
  const controls = [...document.querySelectorAll("button,input,select")];
  controls.forEach((el) => {
    el.disabled = true;
  });
  try {
    await fn();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    controls.forEach((el) => {
      el.disabled = false;
    });
  }
}
for (const mode of ["sync", "upload", "download"]) {
  document.getElementById(mode).addEventListener(
    "click",
    () =>
      void action(async () => {
        const result = await send("run", {
          mode,
          revision: document.getElementById("revision").value || undefined,
        });
        status.textContent = `${result.action} · ${result.revision}`;
      }),
  );
}
document.getElementById("connect").addEventListener(
  "click",
  () =>
    void action(async () => {
      await send("connect");
      status.textContent =
        "Compte Google connecté. Choisissez les réglages de référence lors de la première synchronisation.";
    }),
);
enabled.addEventListener(
  "change",
  () =>
    void action(async () => {
      try {
        const saved = await send("configure", { enabled: enabled.checked });
        enabled.checked = saved.enabled;
        status.textContent = saved.enabled
          ? "Synchronisation automatique activée."
          : "Synchronisation automatique désactivée.";
      } catch (error) {
        enabled.checked = !enabled.checked;
        throw error;
      }
    }),
);
document.getElementById("heads").addEventListener(
  "click",
  () =>
    void action(async () => {
      const heads = await send("heads");
      const select = document.getElementById("revision");
      select.replaceChildren();
      for (const head of heads) {
        const option = document.createElement("option");
        option.value = head.id;
        option.textContent = head.id;
        select.append(option);
      }
      status.textContent = `${heads.length} version(s) distante(s).`;
    }),
);
document.getElementById("backup").addEventListener(
  "click",
  () =>
    void action(async () => {
      const backup = await send("backup");
      if (!backup.snapshot)
        throw new Error("Aucune sauvegarde avant restauration disponible.");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(backup.snapshot, null, 2)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "ublock-before-restore.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }),
);
void action(async () => {
  const data = await send("status");
  enabled.checked = !!data.config.enabled;
  status.textContent = !data.oauthConfigured
    ? "Client OAuth Google à configurer pour ce fork. La synchronisation n’est pas encore connectée."
    : (data.result.error ??
      (data.state.lastSync
        ? `Dernière synchronisation : ${data.state.lastSync}`
        : "Aucune synchronisation effectuée."));
});
