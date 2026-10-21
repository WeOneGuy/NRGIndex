// Всплывающие подтверждения действий: «Отзыв сохранён», «Банка удалена» и т. п.
// Модуль самостоятельный: контейнер создаёт сам, разметка страниц не нужна.
// Текст всегда кладём через textContent — пользовательские строки безопасны.
(() => {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  const MAX_VISIBLE = 3;
  const DURATION = 3200;
  const LEAVE_MS = 220;
  let stack = null;

  const ensureStack = () => {
    if (stack && stack.isConnected) return stack;
    stack = document.createElement("div");
    stack.className = "nrg-toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
    return stack;
  };

  const dismiss = (node) => {
    if (!node || node.classList.contains("is-leaving")) return;
    window.clearTimeout(node.nrgToastTimer);
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), LEAVE_MS);
  };

  const show = (message, options = {}) => {
    const text = String(message ?? "").trim();
    if (!text) return null;
    const tone = options.tone === "error" ? "error" : "ok";
    const duration = Number(options.duration) > 0 ? Number(options.duration) : DURATION;
    const host = ensureStack();

    // Одинаковое сообщение не плодим: подсвечиваем уже показанное и продлеваем жизнь.
    const existing = [...host.children].find(
      (node) => node.dataset.message === text && !node.classList.contains("is-leaving"),
    );
    if (existing) {
      window.clearTimeout(existing.nrgToastTimer);
      existing.classList.remove("is-pulse");
      void existing.offsetWidth; // перезапуск CSS-анимации
      existing.classList.add("is-pulse");
      existing.nrgToastTimer = window.setTimeout(() => dismiss(existing), duration);
      return existing;
    }

    // Держим не больше трёх одновременно: старые убираем сразу, без очереди.
    const visible = [...host.children].filter((node) => !node.classList.contains("is-leaving"));
    while (visible.length >= MAX_VISIBLE) visible.shift().remove();

    const node = document.createElement("div");
    node.className = `nrg-toast nrg-toast--${tone}`;
    node.dataset.message = text;
    node.title = "Скрыть";

    const icon = document.createElement("span");
    icon.className = "nrg-toast__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = tone === "error" ? "!" : "✓";

    const body = document.createElement("span");
    body.className = "nrg-toast__text";
    body.textContent = text;

    node.append(icon, body);
    node.addEventListener("click", () => dismiss(node));
    host.append(node);
    void node.offsetWidth; // фиксируем стартовое состояние до анимации появления
    node.classList.add("is-shown");
    node.nrgToastTimer = window.setTimeout(() => dismiss(node), duration);
    return node;
  };

  window.nrgToast = (message, options) => show(message, options);
  window.nrgToast.error = (message, options = {}) => show(message, { ...options, tone: "error" });
})();
