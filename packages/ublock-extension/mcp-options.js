const key = "browserExtensionsMcp";
const fields = Object.fromEntries(
  ["enabled", "port", "token", "status", "endpoint", "address", "reveal"].map(
    (id) => [id, document.getElementById(id)],
  ),
);
if (new URLSearchParams(location.search).has("embedded"))
  document.body.classList.add("embedded");
fields.enabled.disabled = true;
function hideToken() {
  fields.token.type = "password";
  fields.reveal.setAttribute("aria-pressed", "false");
  fields.reveal.setAttribute("aria-label", "Afficher le token");
  fields.reveal.title = "Afficher le token";
}
async function refreshStatus() {
  try {
    const state = await chrome.runtime.sendMessage({ what: "mcp:status" });
    fields.endpoint.classList.toggle("connected", !!state?.connected);
    fields.endpoint.title = state?.connected
      ? "Serveur connecté"
      : "Serveur déconnecté";
    fields.endpoint.setAttribute(
      "aria-label",
      state?.connected ? "Serveur MCP connecté" : "Serveur MCP déconnecté",
    );
  } catch {
    fields.endpoint.classList.remove("connected");
    fields.endpoint.title = "Serveur déconnecté";
  }
}
function updateAddress() {
  fields.address.textContent = `http://127.0.0.1:${fields.port.value || 17374}/mcp`;
}
chrome.storage.local
  .get(key)
  .then((result) => {
    fields.enabled.checked = !!result[key]?.enabled;
    fields.enabled.disabled = false;
    fields.port.value = result[key]?.port || 17374;
    fields.token.value = result[key]?.token || "";
    hideToken();
    updateAddress();
    fields.status.textContent = result[key]?.token
      ? "Token enregistré · accès local authentifié."
      : "Aucun token enregistré.";
    void refreshStatus();
  })
  .catch(() => {
    fields.status.textContent = "Impossible de lire la configuration.";
  });
fields.port.addEventListener("input", updateAddress);
fields.enabled.addEventListener("change", async () => {
  fields.enabled.disabled = true;
  try {
    const previous = (await chrome.storage.local.get(key))[key];
    await chrome.storage.local.set({
      [key]: { ...previous, enabled: fields.enabled.checked },
    });
    const saved = (await chrome.storage.local.get(key))[key];
    fields.enabled.checked = !!saved?.enabled;
    fields.status.textContent = fields.enabled.checked
      ? "Pont MCP activé · modification enregistrée."
      : "Pont MCP désactivé · modification enregistrée.";
    await refreshStatus();
  } catch {
    const saved = (await chrome.storage.local.get(key).catch(() => ({})))[key];
    if (saved) fields.enabled.checked = !!saved.enabled;
    fields.status.textContent = "Impossible d’enregistrer l’état du pont MCP.";
  } finally {
    fields.enabled.disabled = false;
  }
});
document.getElementById("generate").addEventListener("click", () => {
  fields.token.value = Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  hideToken();
  fields.status.textContent =
    "Nouveau token préparé. Copiez-le dans le trousseau du serveur, puis enregistrez pour l’activer.";
});
fields.reveal.addEventListener("click", () => {
  if (fields.token.type === "text") {
    hideToken();
    return;
  }
  fields.token.type = "text";
  fields.reveal.setAttribute("aria-pressed", "true");
  fields.reveal.setAttribute("aria-label", "Masquer le token");
  fields.reveal.title = "Masquer le token";
});
document.getElementById("copy").addEventListener("click", async () => {
  if (!fields.token.value) {
    fields.status.textContent = "Aucun token à copier.";
    return;
  }
  try {
    await navigator.clipboard.writeText(fields.token.value);
    fields.status.textContent = "Token copié.";
  } catch {
    fields.status.textContent =
      "Copie impossible. Affichez le token pour le copier manuellement.";
  }
});
document.getElementById("config").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const previous = (await chrome.storage.local.get(key))[key];
    const token = fields.token.value || previous?.token;
    const port = Number(fields.port.value);
    if (
      !/^[A-Za-z0-9_-]{32,128}$/.test(token || "") ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535
    ) {
      fields.status.textContent = "Token ou port invalide.";
      return;
    }
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await chrome.storage.local.set({
      [key]: { ...previous, enabled: fields.enabled.checked, port, token },
    });
    fields.token.value = token;
    hideToken();
    fields.status.textContent =
      "Configuration enregistrée. Le serveur doit utiliser le même port et le même token.";
    await refreshStatus();
  } catch {
    fields.status.textContent = "Enregistrement impossible. Réessayez.";
  }
});
window.addEventListener("blur", hideToken);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) hideToken();
});
setInterval(() => void refreshStatus(), 5000);
if (parent !== window) {
  const reportSize = () =>
    parent.postMessage(
      { type: "tmMcpPanelSize", height: document.body.offsetHeight },
      location.origin,
    );
  new ResizeObserver(reportSize).observe(document.body);
  reportSize();
}
