(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
    );

  const api = async (method, path, body) => {
    const res = await fetch(path, {
      method,
      headers: {
        "x-nrg-request": "1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  };

  const state = { me: null, data: null, tab: "drinks", drinksSort: "id-desc", removeImage: false, stats: null, statsDays: 30, database: null };
  // Исходник фото ДО вырезания фона (строго JPEG) — для отправки в Nano Banana.
  // Заполняется при выборе файла/ссылки/ленты; для уже сохранённого фото оригинала
  // нет — тогда шлём текущее с пометкой.
  let adminOriginal = null;
  const remoteImageToDataUrl = async (value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Укажите корректную ссылку на картинку");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Ссылка должна начинаться с http:// или https://");
    }
    // Сайты режут хотлинк/CORS — при ошибке идём через серверный прокси.
    const proxyUrl = `api/cabinet/ai/photo-proxy?url=${encodeURIComponent(url.toString())}`;
    let response = null;
    try {
      response = await fetch(url, { mode: "cors" });
      if (!response.ok) response = await fetch(proxyUrl);
    } catch {
      response = await fetch(proxyUrl);
    }
    if (!response.ok) throw new Error(`Не удалось загрузить картинку (HTTP ${response.status})`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("Ссылка ведёт не на изображение");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Не удалось прочитать картинку"));
      reader.readAsDataURL(blob);
    });
  };
  const status = (id, message, isError = false, notify = false) => {
    const node = $(id);
    if (!node) return;
    node.textContent = message;
    node.style.color = isError ? "#ff8a8a" : "";
    // Подтверждение дублируем тостом: форма бывает прокручена, и статус у кнопки
    // легко не заметить. Ошибки остаются только на месте — они не исчезают сами.
    if (notify && !isError) window.nrgToast?.(message.replace(/\s*✓\s*$/, ""));
  };

  const loadData = async () => {
    state.data = await api("GET", "api/admin/data");
  };

  const refresh = async () => {
    await loadData();
    render();
  };

  /* ---------- tabs ---------- */
  const switchTab = (tab) => {
    state.tab = tab;
    document.querySelectorAll("#admin-tabs .btn").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === tab);
    });
    for (const name of ["drinks", "tiers", "users", "settings", "audit", "logs", "stats", "database"]) {
      $(`tab-${name}`).hidden = name !== tab;
    }
    render();
    if (tab === "stats") loadStats();
    if (tab === "database") loadDatabase();
  };

  const render = () => {
    if (state.tab === "drinks") renderDrinks();
    else if (state.tab === "tiers") renderTiers();
    else if (state.tab === "users") renderUsers();
    else if (state.tab === "settings") renderSettings();
    else if (state.tab === "stats") renderStats();
    else if (state.tab === "logs") renderLogs();
    else if (state.tab === "database") renderDatabase();
    else renderAudit();
  };

  /* ---------- drinks ---------- */
  const drinkCollator = new Intl.Collator("ru-RU", { numeric: true, sensitivity: "base" });
  const drinkVotes = (drink) => Object.keys(drink.ratings || {}).length;
  const sortDrinks = () => {
    const drinks = [...state.data.drinks];
    const sort = state.drinksSort;
    return drinks.sort((a, b) => {
      if (sort === "name-asc") return drinkCollator.compare(a.name, b.name) || b.id - a.id;
      if (sort === "brand-asc") return drinkCollator.compare(a.brand, b.brand) || drinkCollator.compare(a.name, b.name) || b.id - a.id;
      if (sort === "ratings-desc") return drinkVotes(b) - drinkVotes(a) || b.id - a.id;
      if (sort === "ratings-asc") return drinkVotes(a) - drinkVotes(b) || b.id - a.id;
      return sort === "id-asc" ? a.id - b.id : b.id - a.id;
    });
  };

  const renderDrinks = () => {
    const drinks = sortDrinks();
    $("drinks-count").textContent = `${drinks.length} ${wordForm(drinks.length, ["напиток", "напитка", "напитков"])}`;
    $("drinks-table").innerHTML = `
      <table class="admin-table">
        <thead><tr><th></th><th>Название</th><th>Бренд</th><th>Оценки</th><th>Статус</th><th></th></tr></thead>
        <tbody>
          ${drinks
            .map((drink) => {
              const votes = drinkVotes(drink);
              return `
            <tr>
              <td>${drink.image ? `<img src="${esc(drink.image)}" alt="">` : "—"}</td>
              <td><b>${esc(drink.name)}</b><br><span class="muted">${esc(drink.flavor)}</span></td>
              <td>${esc(drink.brand)}</td>
              <td class="admin-ratings"><b>${votes}</b><button class="btn btn--ghost" type="button" data-raters="${drink.id}">Кто оценил</button></td>
              <td><span class="admin-badge ${drink.published ? "admin-badge--on" : "admin-badge--off"}">${drink.published ? "опубликован" : "скрыт"}</span></td>
              <td class="admin-actions">
                <button class="btn btn--ghost" type="button" data-edit="${drink.id}">Править</button>
                <button class="btn btn--ghost" type="button" data-toggle="${drink.id}">${drink.published ? "Скрыть" : "Опубликовать"}</button>
                ${String(drink.image || "").startsWith("/uploads/") ? `<button class="btn btn--ghost" type="button" data-reprocess="${drink.id}">Переобработать</button>` : ""}
                <button class="btn btn--ghost" type="button" data-merge="${drink.id}">Объединить</button>
                <button class="btn btn--danger" type="button" data-delete="${drink.id}">Удалить</button>
              </td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;

    const container = $("drinks-table");
    container.querySelectorAll("[data-edit]").forEach((button) => {
      button.onclick = () => openDrinkForm(Number(button.dataset.edit));
    });
    container.querySelectorAll("[data-toggle]").forEach((button) => {
      button.onclick = async () => {
        const drink = state.data.drinks.find((item) => item.id === Number(button.dataset.toggle));
        if (drink.published) {
          const ok = await window.nrgConfirm({
            title: "Скрыть напиток?",
            message: `«${drink.name}» пропадёт с публичного сайта вместе с оценками. Вернуть можно кнопкой «Опубликовать».`,
            confirmText: "Скрыть",
          });
          if (!ok) return;
        }
        try {
          await api("PATCH", `api/admin/drinks/${drink.id}`, { published: !drink.published });
          await refresh();
          window.nrgToast?.(drink.published ? "Напиток скрыт с сайта" : "Напиток опубликован");
        } catch (error) {
          status("global-status", error.message, true);
        }
      };
    });
    container.querySelectorAll("[data-reprocess]").forEach((button) => {
      button.onclick = async () => {
        try {
          status("global-status", "Обрабатываю картинку…");
          await api("POST", `api/admin/drinks/${button.dataset.reprocess}/reprocess-image`, {});
          await refresh();
          status("global-status", "Картинка переобработана, цвет обновлён ✓", false, true);
        } catch (error) {
          status("global-status", error.message, true);
        }
      };
    });
    container.querySelectorAll("[data-delete]").forEach((button) => {
      button.onclick = async () => {
        const drink = state.data.drinks.find((item) => item.id === Number(button.dataset.delete));
        const votes = Object.keys(drink.ratings || {}).length;
        const ok = await window.nrgConfirm({
          title: "Удалить напиток?",
          message: `«${drink.name}» будет удалён целиком.`,
          details: [
            votes ? `Вместе с ним удалятся оценки: ${votes}` : "Оценок у напитка нет",
            state.me.role === "admin" ? "Откатить можно в «Журнале»" : "",
          ],
          confirmText: "Удалить напиток",
        });
        if (!ok) return;
        try {
          await api("DELETE", `api/admin/drinks/${drink.id}`);
          await refresh();
          status("global-status", `«${drink.name}» удалён`, false, true);
        } catch (error) {
          status("global-status", error.message, true);
        }
      };
    });
    container.querySelectorAll("[data-merge]").forEach((button) => {
      button.onclick = () => openMergeDialog(state.data.drinks.find((item) => item.id === Number(button.dataset.merge)));
    });
    container.querySelectorAll("[data-raters]").forEach((button) => {
      button.onclick = () => openRaters(state.data.drinks.find((item) => item.id === Number(button.dataset.raters)));
    });
  };

  let ratersDialog = null;
  const openRaters = (drink) => {
    if (!drink) return;
    if (!ratersDialog) {
      ratersDialog = document.createElement("dialog");
      ratersDialog.className = "admin-raters";
      ratersDialog.setAttribute("aria-labelledby", "raters-title");
      ratersDialog.innerHTML = `
        <div class="admin-raters__body">
          <header class="admin-raters__head">
            <div>
              <p class="eyebrow">Личные вердикты</p>
              <h2 id="raters-title">Кто оценил</h2>
            </div>
            <button class="admin-raters__close" type="button" data-close aria-label="Закрыть">×</button>
          </header>
          <div class="admin-raters__drink"></div>
          <p class="admin-raters__summary" id="raters-summary"></p>
          <ul class="admin-raters__list"></ul>
          <footer class="admin-raters__foot">
            <span>Включая скрытых участников</span>
            <button class="btn btn--ghost" type="button" data-close>Закрыть</button>
          </footer>
        </div>`;
      ratersDialog.addEventListener("click", (event) => {
        if (event.target === ratersDialog) ratersDialog.close();
      });
      ratersDialog.querySelectorAll("[data-close]").forEach((button) => {
        button.onclick = () => ratersDialog.close();
      });
      document.body.append(ratersDialog);
    }
    const entries = Object.entries(drink.ratings || {});
    ratersDialog.querySelector(".admin-raters__drink").innerHTML = `
      ${drink.image ? `<img src="${esc(drink.image)}" alt="">` : ""}
      <div><span>${esc(drink.brand)}</span><h3>${esc(drink.name)}</h3><p>${esc([drink.flavor, drink.edition].filter(Boolean).join(" · "))}</p></div>`;
    ratersDialog.querySelector("#raters-summary").textContent = `${entries.length} ${wordForm(entries.length, ["оценка", "оценки", "оценок"])}`;
    ratersDialog.querySelector(".admin-raters__list").innerHTML = entries.length
      ? entries
          .map(([username, rating]) => {
            const user = state.data.users.find((item) => item.username === username);
            const tier = String(rating.tier || "—").toUpperCase();
            const name = user?.displayName || username;
            const initials = user?.initials || [...name].slice(0, 2).join("").toUpperCase();
            const note = user ? (user.isPublic ? "" : " · скрыт с сайта") : " · пользователь удалён";
            return `
          <li class="admin-raters__row">
            <span class="admin-raters__avatar" style="--person-color:${safeColor(user?.color, "#ff7448")}">${user?.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials)}</span>
            <div class="admin-raters__who">
              <b>${esc(name)}</b>
              <span>@${esc(username)}${esc(note)}</span>
            </div>
            <span class="admin-raters__tier" style="--tier-color:${safeColor(TIER_COLORS[tier], "#e7ded1")}" aria-label="Тир ${esc(tier)}">${esc(tier)}</span>
            ${rating.review?.trim() ? `<blockquote class="admin-raters__review">${esc(rating.review)}</blockquote>` : `<span class="admin-raters__no-review">Без текстового отзыва</span>`}
          </li>`;
          })
          .join("")
      : `<li class="admin-raters__empty"><span>∅</span><b>Пока никто не оценил</b><small>Когда появится первая оценка, здесь будет видно кто её оставил.</small></li>`;
    ratersDialog.showModal();
    ratersDialog.querySelector(".admin-raters__list").scrollTop = 0;
    ratersDialog.querySelector("[data-close]").focus();
  };

  let mergeDialog = null;
  let mergeSource = null;

  const renderMergeList = () => {
    if (!mergeDialog || !mergeSource) return;
    const query = mergeDialog.querySelector("#merge-search").value.trim().toLowerCase();
    const items = state.data.drinks
      .filter((item) => item.id !== mergeSource.id)
      .filter(
        (item) =>
          !query || `${item.brand} ${item.name} ${item.flavor} ${item.edition}`.toLowerCase().includes(query),
      );
    const list = mergeDialog.querySelector("#merge-list");
    const submit = mergeDialog.querySelector("#merge-submit");
    submit.disabled = true;
    list.innerHTML = items.length
      ? items
          .map((item) => {
            const votes = Object.keys(item.ratings || {}).length;
            return `
          <li class="admin-merge__row">
            <label>
              <input type="radio" name="merge-target" value="${item.id}">
              <span class="admin-merge__name">
                <b>${esc(item.name)}</b>
                <small>${esc(item.brand)}${item.flavor ? ` · ${esc(item.flavor)}` : ""}${item.published ? "" : " · скрыт"}</small>
              </span>
              <span class="admin-merge__votes">${votes} ${wordForm(votes, ["оценка", "оценки", "оценок"])}</span>
            </label>
          </li>`;
          })
          .join("")
      : `<li class="admin-merge__empty">Ничего не найдено — измени запрос.</li>`;
    list.querySelectorAll('input[name="merge-target"]').forEach((input) => {
      input.onchange = () => {
        submit.disabled = false;
        const target = state.data.drinks.find((item) => item.id === Number(input.value));
        if (target) {
          mergeDialog.querySelector("#merge-note").textContent =
            `Дубль исчезнет: «${mergeSource.name}» → «${target.name}»`;
        }
      };
    });
  };

  const submitMerge = async () => {
    if (!mergeDialog || !mergeSource) return;
    const selected = mergeDialog.querySelector('input[name="merge-target"]:checked');
    if (!selected) return;
    const source = mergeSource;
    const target = state.data.drinks.find((item) => item.id === Number(selected.value));
    if (!target) return;
    const votes = Object.keys(source.ratings || {}).length;
    const ok = await window.nrgConfirm({
      title: "Объединить напитки?",
      message: `«${source.brand} ${source.name}» исчезнет, а его оценки и отзывы перейдут в «${target.brand} ${target.name}».`,
      details: [
        votes ? `Перенесётся оценок: ${votes}` : "У дубля нет оценок",
        "Связи «похожих» и пустые поля тоже переедут",
        state.me.role === "admin" ? "Откатить можно в «Журнале»" : "",
      ],
      confirmText: "Объединить",
    });
    if (!ok) return;
    try {
      const result = await api("POST", `api/admin/drinks/${source.id}/merge`, { targetId: target.id });
      mergeDialog.close();
      await refresh();
      const moved = result.movedRatings ? `, перенесено оценок: ${result.movedRatings}` : "";
      status("global-status", `«${source.name}» объединён с «${target.name}»${moved}`, false, true);
    } catch (error) {
      status("global-status", error.message, true);
    }
  };

  const openMergeDialog = (source) => {
    if (!source) return;
    if (state.data.drinks.length < 2) {
      status("global-status", "Для объединения нужен ещё хотя бы один напиток", true);
      return;
    }
    mergeSource = source;
    if (!mergeDialog) {
      mergeDialog = document.createElement("dialog");
      mergeDialog.className = "admin-raters admin-merge";
      mergeDialog.setAttribute("aria-labelledby", "merge-title");
      mergeDialog.innerHTML = `
        <div class="admin-raters__body">
          <header class="admin-raters__head">
            <div>
              <p class="eyebrow">Склейка дублей</p>
              <h2 id="merge-title">Объединить напиток</h2>
            </div>
            <button class="admin-raters__close" type="button" data-close aria-label="Закрыть">×</button>
          </header>
          <div class="admin-raters__drink"></div>
          <p class="admin-raters__summary" id="merge-summary"></p>
          <label class="admin-merge__search">Куда перенести
            <input id="merge-search" type="search" placeholder="поиск: бренд, название, вкус…" autocomplete="off">
          </label>
          <ul class="admin-raters__list admin-merge__list" id="merge-list"></ul>
          <footer class="admin-raters__foot">
            <span id="merge-note">Дубль исчезнет: оценки, отзывы и связи перейдут в выбранный напиток.</span>
            <div class="admin-actions">
              <button class="btn" type="button" id="merge-submit" disabled>Объединить</button>
              <button class="btn btn--ghost" type="button" data-close>Отмена</button>
            </div>
          </footer>
        </div>`;
      mergeDialog.addEventListener("click", (event) => {
        if (event.target === mergeDialog) mergeDialog.close();
      });
      mergeDialog.querySelectorAll("[data-close]").forEach((button) => {
        button.onclick = () => mergeDialog.close();
      });
      mergeDialog.querySelector("#merge-search").oninput = renderMergeList;
      mergeDialog.querySelector("#merge-submit").onclick = submitMerge;
      document.body.append(mergeDialog);
    }
    const votes = Object.keys(source.ratings || {}).length;
    mergeDialog.querySelector(".admin-raters__drink").innerHTML = `
      ${source.image ? `<img src="${esc(source.image)}" alt="">` : ""}
      <div><span>${esc(source.brand)}</span><h3>${esc(source.name)}</h3><p>${esc([source.flavor, source.edition].filter(Boolean).join(" · "))}</p></div>`;
    mergeDialog.querySelector("#merge-summary").textContent = `Дубль · оценок: ${votes}`;
    mergeDialog.querySelector("#merge-search").value = "";
    mergeDialog.querySelector("#merge-note").textContent =
      "Дубль исчезнет: оценки, отзывы и связи перейдут в выбранный напиток.";
    renderMergeList();
    mergeDialog.showModal();
    mergeDialog.querySelector("#merge-search").focus();
  };

  const openDrinkForm = (id) => {
    const drink = id ? state.data.drinks.find((item) => item.id === id) : null;
    $("d-id").value = drink ? drink.id : "";
    $("d-brand").value = drink?.brand || "";
    $("d-name").value = drink?.name || "";
    $("d-flavor").value = drink?.flavor || "";
    $("d-edition").value = drink?.edition || "";
    $("d-source").value = drink?.sourceLabel || "";
    $("d-accent-a").value = drink?.accent?.[0] || "#ff4f79";
    $("d-accent-b").value = drink?.accent?.[1] || "#ff7448";
    $("d-published").checked = drink ? drink.published : true;
    $("d-image-path").value = drink?.image || "";
    const preview = $("d-image-preview");
    if (drink?.image) {
      preview.src = drink.image;
      preview.hidden = false;
    } else {
      preview.hidden = true;
      preview.removeAttribute("src");
    }
    resetPhotoStrip();
    $("d-image-tools").hidden = true;
    $("d-photo-query").value = drink
      ? [drink.brand, drink.name, drink.flavor].filter(Boolean).join(" ")
      : "";
    state.removeImage = false;
    adminOriginal = null;
    $("d-related").innerHTML = state.data.drinks
      .filter((item) => item.id !== (drink?.id || -1))
      .map(
        (item) =>
          `<option value="${item.id}" ${drink?.related?.includes(item.id) ? "selected" : ""}>${esc(item.name)}${item.flavor ? ` · ${esc(item.flavor)}` : ""}</option>`,
      )
      .join("");
    $("drink-form").hidden = false;
    status("drink-status", drink ? `Правка напитка #${drink.id}` : "Новый напиток");
  };

  $("btn-drink-new").onclick = () => openDrinkForm(null);
  $("btn-drink-cancel").onclick = () => {
    $("drink-form").hidden = true;
    $("drink-form").reset();
    resetPhotoStrip();
  };

  // Все способы замены фото живут за кликом по превью — форма не завалена кнопками.
  $("d-image-open").onclick = () => {
    const tools = $("d-image-tools");
    tools.hidden = !tools.hidden;
    if (!tools.hidden) status("drink-status", "Выбери способ: файл, ссылка, поиск или перерисовка 🍌");
  };

  $("d-image-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      status("drink-status", "Обрабатываю картинку…");
      const dataUrl = await fileToDataUrl(file, 1200);
      adminOriginal = await toJpegDataUrl(dataUrl);
      const { path, accent } = await api("POST", "api/uploads", { dataUrl });
      state.removeImage = false;
      $("d-image-path").value = path;
      $("d-accent-a").value = accent[0];
      $("d-accent-b").value = accent[1];
      const preview = $("d-image-preview");
      preview.src = path;
      preview.hidden = false;
      status("drink-status", `Готово: фон вырезан, цвет ${accent[0]} / ${accent[1]}`);
    } catch (error) {
      status("drink-status", error.message || "Не удалось прочитать файл", true);
    } finally {
      event.target.value = "";
    }
  });

  $("btn-drink-image-url").onclick = async () => {
    const value = $("d-image-url").value.trim();
    if (!value) return;
    try {
      status("drink-status", "Загружаю картинку по ссылке…");
      const dataUrl = await remoteImageToDataUrl(value);
      adminOriginal = await toJpegDataUrl(dataUrl);
      const { path, accent } = await api("POST", "api/uploads", { dataUrl });
      state.removeImage = false;
      $("d-image-path").value = path;
      $("d-accent-a").value = accent[0];
      $("d-accent-b").value = accent[1];
      $("d-image-preview").src = path;
      $("d-image-preview").hidden = false;
      status("drink-status", "Картинка загружена и обработана ✓");
    } catch (error) {
      status("drink-status", error.message, true);
    }
  };

  const resetPhotoStrip = () => {
    $("d-photo-strip").hidden = true;
    $("d-photo-track").innerHTML = "";
    $("d-photo-status").textContent = "";
  };

  const pickDrinkPhoto = async (item, tile) => {
    if (!item?.url) return;
    try {
      status("drink-status", "Загружаю выбранное фото…");
      tile?.classList.add("is-loading");
      const dataUrl = await remoteImageToDataUrl(item.url);
      adminOriginal = await toJpegDataUrl(dataUrl);
      const { path, accent } = await api("POST", "api/uploads", { dataUrl });
      state.removeImage = false;
      $("d-image-path").value = path;
      $("d-accent-a").value = accent[0];
      $("d-accent-b").value = accent[1];
      $("d-image-preview").src = path;
      $("d-image-preview").hidden = false;
      $("d-photo-track")
        .querySelectorAll(".photo-tile")
        .forEach((node) => node.classList.remove("is-selected", "is-loading"));
      tile?.classList.add("is-selected");
      status("drink-status", `Фото заменено: фон вырезан, цвет ${accent[0]} / ${accent[1]}`);
    } catch (error) {
      tile?.classList.remove("is-loading");
      status("drink-status", error.message, true);
    }
  };

  const searchDrinkPhotos = async () => {
    const typed = $("d-photo-query").value.trim();
    const query =
      typed ||
      [$("d-brand").value, $("d-name").value, $("d-flavor").value]
        .map((value) => value.trim())
        .filter(Boolean)
        .join(" ");
    if (query.replace(/\s+/g, "").length < 2) {
      status("drink-status", "Введи хотя бы 2 символа или заполни бренд и название", true);
      return;
    }
    try {
      status("drink-status", "Ищу фото…");
      $("d-photo-strip").hidden = false;
      $("d-photo-track").innerHTML = "";
      $("d-photo-status").textContent = "ищу…";
      const params = new URLSearchParams({ q: query });
      const { images } = await api("GET", `api/cabinet/ai/photo-search?${params}`);
      if (!images?.length) {
        $("d-photo-status").textContent = "ничего не нашлось — уточни запрос";
        return;
      }
      $("d-photo-status").textContent = `${images.length} шт · жми нужное`;
      images.forEach((item) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "photo-tile";
        tile.title = [item.title, item.source].filter(Boolean).join(" · ");
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        img.src = item.url;
        img.onerror = () => {
          if (img.dataset.proxied) {
            tile.remove();
            return;
          }
          img.dataset.proxied = "1";
          img.src = `api/cabinet/ai/photo-proxy?url=${encodeURIComponent(item.url)}`;
        };
        tile.appendChild(img);
        tile.onclick = () => pickDrinkPhoto(item, tile);
        $("d-photo-track").appendChild(tile);
      });
      status("drink-status", "Выбери фото из ленты — оно сразу загрузится и обработается");
    } catch (error) {
      $("d-photo-status").textContent = "";
      status("drink-status", error.message, true);
    }
  };

  $("btn-drink-photo-search").onclick = searchDrinkPhotos;
  $("d-photo-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchDrinkPhotos();
    }
  });

  $("d-image-path").addEventListener("input", () => {
    // Путь поправили руками — старый «оригинал» уже не от этой картинки.
    adminOriginal = null;
    const preview = $("d-image-preview");
    const value = $("d-image-path").value.trim();
    if (value) {
      state.removeImage = false;
      preview.src = value;
      preview.hidden = false;
    } else {
      state.removeImage = true;
      preview.hidden = true;
      preview.removeAttribute("src");
    }
  });

  $("btn-drink-image-clear").onclick = () => {
    state.removeImage = true;
    adminOriginal = null;
    $("d-image-path").value = "";
    $("d-image-preview").hidden = true;
    $("d-image-preview").removeAttribute("src");
    status("drink-status", "Картинка будет убрана при сохранении");
  };

  // 🍌 Перерисовка через Nano Banana. В модель идёт исходник ДО вырезания фона
  // строго JPEG (свежий файл/ссылка/лента — сохранённый adminOriginal,
  // иначе текущее фото с пометкой). Зелёный хромакей результата вырезает сервер
  // при заливке — removeBorderBackground режет по медиане рамки, не только белое.
  $("btn-drink-redraw").onclick = async () => {
    try {
      const usesOpenRouter = state.data.settings.imageProvider === "openrouter";
      let source = adminOriginal;
      let note = "";
      if (!source) {
        const preview = $("d-image-preview");
        const url = (!preview.hidden && preview.src) || $("d-image-path").value.trim();
        if (!url) {
          status("drink-status", "Нет фото для перерисовки — загрузи файл, ссылку или выбери из ленты", true);
          return;
        }
        note = " (оригинал не сохранился — шлю текущее фото)";
        status("drink-status", "Готовлю исходник…");
        source = await toJpegDataUrl(await pathToDataUrl(url));
      }
      if (usesOpenRouter ? !source.startsWith("data:image/") : !source.startsWith("data:image/jpeg")) {
        throw new Error(usesOpenRouter ? "Исходник не картинка — что-то пошло не так" : "Исходник не JPEG — что-то пошло не так");
      }
      status("drink-status", usesOpenRouter ? "OpenRouter перерисовывает на прозрачном фоне…" : "Nano Banana перерисовывает…");
      const { imageDataUrl, provider } = await api("POST", "api/cabinet/ai/photo-redraw", { imageDataUrl: source });
      const applyUploaded = (path, accent) => {
        state.removeImage = false;
        $("d-image-path").value = path;
        $("d-accent-a").value = accent[0];
        $("d-accent-b").value = accent[1];
        $("d-image-preview").src = path;
        $("d-image-preview").hidden = false;
      };
      if (provider === "openrouter") {
        const png = await toPngDataUrl(imageDataUrl);
        adminOriginal = png;
        status("drink-status", "Заливаю результат (фон уже прозрачный)…");
        const { path, accent } = await api("POST", "api/uploads", { dataUrl: png });
        applyUploaded(path, accent);
        status("drink-status", `Перерисовано 🍌${note} — прозрачный фон, цвет ${accent[0]} / ${accent[1]}`);
        return;
      }
      adminOriginal = await toJpegDataUrl(imageDataUrl);
      status("drink-status", "Заливаю результат (фон вырежется сам)…");
      const { path, accent } = await api("POST", "api/uploads", { dataUrl: imageDataUrl });
      applyUploaded(path, accent);
      status("drink-status", `Перерисовано 🍌${note} — фон вырезан, цвет ${accent[0]} / ${accent[1]}`);
    } catch (error) {
      status("drink-status", error.message || "Не удалось перерисовать", true);
    }
  };

  // Повторный клик по «Сохранить», пока первый запрос ещё летит, создавал вторую
  // банку — глушим повтор и блокируем кнопку до ответа сервера.
  let drinkSaving = false;
  $("drink-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (drinkSaving) return;
    drinkSaving = true;
    const submitButton = event.submitter || $("drink-form").querySelector('[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    const payload = {
      brand: $("d-brand").value,
      name: $("d-name").value,
      flavor: $("d-flavor").value,
      edition: $("d-edition").value,
      sourceLabel: $("d-source").value,
      accentA: $("d-accent-a").value,
      accentB: $("d-accent-b").value,
      published: $("d-published").checked,
      relatedIds: [...$("d-related").selectedOptions].map((option) => Number(option.value)),
    };
    const imagePath = $("d-image-path").value.trim();
    if (imagePath) payload.image = imagePath;
    else if (state.removeImage) payload.removeImage = true;
    try {
      const id = $("d-id").value;
      if (id) await api("PATCH", `api/admin/drinks/${id}`, payload);
      else await api("POST", "api/admin/drinks", payload);
      $("drink-form").hidden = true;
      $("drink-form").reset();
      await refresh();
      status("global-status", "Напиток сохранён ✓", false, true);
    } catch (error) {
      status("drink-status", error.message, true);
    } finally {
      drinkSaving = false;
      if (submitButton) submitButton.disabled = false;
    }
  });

  /* ---------- tiers ---------- */
  const renderTiers = () => {
    const tiers = state.data.tiers;
    $("tiers-table").innerHTML = `
      <table class="admin-table">
        <thead><tr><th>ID</th><th>Название</th><th>Описание</th><th>Балл</th><th>Позиция</th><th></th></tr></thead>
        <tbody>
          ${tiers
            .map(
              (tier) => `
            <tr>
              <td><b>${esc(tier.id)}</b></td>
              <td>${esc(tier.title)}</td>
              <td class="muted">${esc(tier.note)}</td>
              <td>${tier.score}</td>
              <td>${tier.position}</td>
              <td class="admin-actions">
                <button class="btn btn--ghost" type="button" data-edit="${esc(tier.id)}">Править</button>
                <button class="btn btn--danger" type="button" data-delete="${esc(tier.id)}">Удалить</button>
              </td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>`;

    const container = $("tiers-table");
    container.querySelectorAll("[data-edit]").forEach((button) => {
      button.onclick = () => openTierForm(button.dataset.edit);
    });
    container.querySelectorAll("[data-delete]").forEach((button) => {
      button.onclick = async () => {
        const tier = state.data.tiers.find((item) => item.id === button.dataset.delete);
        const ok = await window.nrgConfirm({
          title: `Удалить тир ${tier.id}?`,
          message: `Тир «${tier.title}» исчезнет со всех досок. Если он используется в оценках, сервер не даст удалить.`,
          confirmText: "Удалить тир",
        });
        if (!ok) return;
        try {
          await api("DELETE", `api/admin/tiers/${encodeURIComponent(button.dataset.delete)}`);
          await refresh();
          window.nrgToast?.(`Тир ${button.dataset.delete} удалён`);
        } catch (error) {
          status("global-status", error.message, true);
        }
      };
    });
  };

  const openTierForm = (id) => {
    const tier = id ? state.data.tiers.find((item) => item.id === id) : null;
    $("t-id-original").value = tier ? tier.id : "";
    $("t-id").value = tier?.id || "";
    $("t-id").disabled = Boolean(tier);
    $("t-title").value = tier?.title || "";
    $("t-note").value = tier?.note || "";
    $("t-score").value = tier?.score ?? 3;
    $("t-position").value = tier?.position ?? 10;
    $("tier-form").hidden = false;
    status("tier-status", tier ? `Правка тира ${tier.id}` : "Новый тир");
  };

  $("btn-tier-new").onclick = () => openTierForm(null);
  $("btn-tier-cancel").onclick = () => {
    $("tier-form").hidden = true;
    $("tier-form").reset();
  };

  $("tier-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      title: $("t-title").value,
      note: $("t-note").value,
      score: Number($("t-score").value),
      position: Number($("t-position").value),
    };
    try {
      const original = $("t-id-original").value;
      if (original) {
        await api("PATCH", `api/admin/tiers/${encodeURIComponent(original)}`, payload);
      } else {
        await api("POST", "api/admin/tiers", { id: $("t-id").value, ...payload });
      }
      $("tier-form").hidden = true;
      $("tier-form").reset();
      await refresh();
      status("global-status", "Тир сохранён ✓", false, true);
    } catch (error) {
      status("tier-status", error.message, true);
    }
  });

  /* ---------- users ---------- */
  const roleLabels = { admin: "админ", editor: "редактор", user: "юзер" };

  const renderUsers = () => {
    const users = state.data.users;
    $("users-table").innerHTML = `
      <table class="admin-table">
        <thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>Должность</th><th>Пароль</th><th>Статус</th><th>Публичность</th><th></th></tr></thead>
        <tbody>
          ${users
            .map(
              (user) => `
            <tr>
              <td><b>${esc(user.username)}</b></td>
              <td>${esc(user.displayName)}</td>
              <td>${esc(roleLabels[user.role] || user.role)}</td>
              <td class="muted">${esc(user.title)}</td>
              <td>${user.hasPassword ? (user.mustChangePassword ? "временный" : "задан") : "нет"}</td>
              <td><span class="admin-badge ${user.isActive ? "admin-badge--on" : "admin-badge--off"}">${user.isActive ? "активен" : "отключён"}</span></td>
              <td><span class="admin-badge ${user.isPublic ? "admin-badge--on" : "admin-badge--off"}">${user.isPublic ? "на сайте" : "скрыт"}</span></td>
              <td class="admin-actions">
                <a class="btn btn--ghost" href="/profile.html?u=${encodeURIComponent(user.username)}" target="_blank" rel="noopener">Профиль</a>
                <button class="btn btn--ghost" type="button" data-edit="${user.id}">Править</button>
                <button class="btn btn--ghost" type="button" data-reset="${user.id}">Сбросить пароль</button>
                <button class="btn btn--danger" type="button" data-delete="${user.id}">Удалить</button>
              </td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>`;

    const container = $("users-table");
    container.querySelectorAll("[data-edit]").forEach((button) => {
      button.onclick = () => openUserForm(Number(button.dataset.edit));
    });
    container.querySelectorAll("[data-reset]").forEach((button) => {
      button.onclick = async () => {
        const user = state.data.users.find((item) => item.id === Number(button.dataset.reset));
        const ok = await window.nrgConfirm({
          title: "Сбросить пароль?",
          message: `${user.displayName} (@${user.username}) получит временный пароль.`,
          details: ["Все его сессии завершатся", "Это действие не откатывается"],
          confirmText: "Сбросить",
        });
        if (!ok) return;
        try {
          const { tempPassword } = await api("POST", `api/admin/users/${user.id}/password`, {});
          $("global-status").innerHTML = `Временный пароль для <b>${esc(user.username)}</b>: <span class="admin-temp">${esc(tempPassword)}</span> — передайте и попросите сменить.`;
          await refresh();
          window.nrgToast?.(`Пароль @${user.username} сброшен`);
        } catch (error) {
          status("global-status", error.message, true);
        }
      };
    });
    container.querySelectorAll("[data-delete]").forEach((button) => {
      button.onclick = async () => {
        const user = state.data.users.find((item) => item.id === Number(button.dataset.delete));
        const ratedCount = state.data.drinks.filter((drink) => drink.ratings?.[user.username]).length;
        const ok = await window.nrgConfirm({
          title: "Удалить пользователя?",
          message: `${user.displayName} (@${user.username}) потеряет доступ, аккаунт будет удалён.`,
          details: [
            ratedCount ? `Вместе с ним удалятся оценки: ${ratedCount}` : "Оценок у него нет",
            "Откатить можно в «Журнале»",
          ],
          confirmText: "Удалить пользователя",
        });
        if (!ok) return;
        try {
          await api("DELETE", `api/admin/users/${user.id}`);
          await refresh();
          window.nrgToast?.(`Пользователь ${user.username} удалён`);
        } catch (error) {
          status("global-status", error.message, true);
        }
      };
    });
  };

  const openUserForm = (id) => {
    const user = id ? state.data.users.find((item) => item.id === id) : null;
    $("u-id").value = user ? user.id : "";
    $("u-username").value = user?.username || "";
    $("u-name").value = user?.displayName || "";
    $("u-role").value = user?.role || "user";
    $("u-title").value = user?.title || "";
    $("u-initials").value = user?.initials || "";
    $("u-color").value = user?.color || "#9fb7ff";
    $("u-active").checked = user ? user.isActive : true;
    $("u-public").checked = user ? user.isPublic : true;
    $("u-active-row").hidden = !user;
    $("u-password-row").hidden = Boolean(user);
    $("u-password").value = "";
    $("user-form").hidden = false;
    $("user-form").scrollIntoView({ behavior: "smooth", block: "start" });
    status("user-status", user ? `Правка ${user.username}` : "Новый пользователь");
  };

  $("btn-user-new").onclick = () => openUserForm(null);
  $("btn-user-cancel").onclick = () => {
    $("user-form").hidden = true;
    $("user-form").reset();
  };

  $("user-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const id = $("u-id").value;
      if (id) {
        const payload = {
          username: $("u-username").value.trim().toLowerCase(),
          displayName: $("u-name").value,
          role: $("u-role").value,
          title: $("u-title").value,
          initials: $("u-initials").value,
          color: $("u-color").value,
          isActive: $("u-active").checked,
          isPublic: $("u-public").checked,
        };
        const current = state.data.users.find((item) => item.id === Number(id));
        const isSelf = current.id === state.me?.id;
        const warnings = [];
        if (payload.username !== current.username) {
          warnings.push(
            isSelf
              ? `Ваш логин для входа станет «${payload.username}» — старый перестанет работать`
              : `Логин для входа станет «${payload.username}» — сообщите пользователю`,
          );
        }
        if (current.isActive && !payload.isActive) warnings.push("Доступ будет отключён, все сессии завершатся");
        if (current.role === "admin" && payload.role !== "admin") warnings.push("Пользователь потеряет права админа");
        if (current.isPublic && !payload.isPublic) warnings.push("Он и его оценки пропадут с публичного сайта");
        if (warnings.length) {
          const ok = await window.nrgConfirm({
            title: "Сохранить изменения?",
            message: `${current.displayName} (@${current.username}):`,
            details: warnings,
            confirmText: "Сохранить",
          });
          if (!ok) return;
        }
        await api("PATCH", `api/admin/users/${id}`, payload);
        $("user-form").hidden = true;
        await refresh();
        status("global-status", "Пользователь обновлён ✓", false, true);
      } else {
        const payload = {
          username: $("u-username").value,
          displayName: $("u-name").value,
          role: $("u-role").value,
          title: $("u-title").value,
          initials: $("u-initials").value,
          color: $("u-color").value,
          isPublic: $("u-public").checked,
          password: $("u-password").value || undefined,
        };
        const { user, tempPassword } = await api("POST", "api/admin/users", payload);
        $("user-form").hidden = true;
        await refresh();
        if (tempPassword) {
          $("global-status").innerHTML = `Создан <b>${esc(user.username)}</b>. Временный пароль: <span class="admin-temp">${esc(tempPassword)}</span> — передайте и попросите сменить.`;
        } else {
          status("global-status", "Пользователь создан ✓", false, true);
        }
      }
    } catch (error) {
      status("user-status", error.message, true);
    }
  });

  /* ---------- settings ---------- */
  const renderSettings = () => {
    const settings = state.data.settings;
    $("s-title").value = settings.siteTitle || "";
    $("s-description").value = settings.siteDescription || "";
    $("s-model").value = settings.textModel || settings.openrouterModel || "";
    $("s-stt-model").value = settings.sttModel || "";
    $("s-base-url").value = settings.textBaseUrl || settings.aiBaseUrl || "";
    $("s-model").placeholder = settings.defaults?.textModel || settings.defaults?.openrouterModel || "";
    $("s-stt-model").placeholder = settings.defaults?.sttModel || "";
    $("s-base-url").placeholder = settings.defaults?.textBaseUrl || settings.defaults?.aiBaseUrl || "";
    $("s-key").value = "";
    $("s-key").placeholder = settings.textApiKeySet
      ? "задан — оставьте пустым, чтобы не менять"
      : "не задан";
    $("s-openrouter-key").value = "";
    $("s-openrouter-key").placeholder = settings.openrouterKeySet
      ? "задан — оставьте пустым, чтобы не менять"
      : "не задан";
    // прокси из env в поле не подставляем, иначе при сохранении он «переедет» в БД
    $("s-proxy").value = settings.aiProxyFromEnv ? "" : settings.aiProxyUrl || "";
    if (settings.aiProxyFromEnv) $("s-proxy").placeholder = `из AI_PROXY_URL: ${settings.aiProxyUrl}`;
    $("s-google-key").value = "";
    $("s-google-key").placeholder = settings.googleCseFromEnv
      ? "задан через GOOGLE_CSE_KEY — ввод заменит на значение из БД"
      : settings.googleCseKeySet
        ? "задан — оставьте пустым, чтобы не менять"
        : "не задан";
    // CX не секрет — показываем сохранённый, из env не подставляем
    $("s-google-cx").value = settings.googleCseCx || "";
    $("s-gemini-key").value = "";
    $("s-gemini-key").placeholder = settings.geminiFromEnv
      ? "задан через GEMINI_API_KEY — ввод заменит на значение из БД"
      : settings.geminiKeySet
        ? "задан — оставьте пустым, чтобы не менять"
        : "не задан";
    $("s-gemini-model").value = settings.geminiImageModel || "";
    $("s-gemini-model").placeholder = "gemini-3.1-flash-lite-image";
    $("s-gemini-vision-model").value = settings.geminiVisionModel || "";
    $("s-gemini-vision-model").placeholder = "gemini-3.8-flash";
    $("s-image-provider").value = settings.imageProvider === "openrouter" ? "openrouter" : "gemini";
    $("s-openrouter-image-model").value = settings.openrouterImageModel || "";
    $("s-openrouter-image-model").placeholder = settings.defaults?.openrouterImageModel || "openai/gpt-image-2.5-sunburst";
    $("s-openrouter-image-prompt").value = settings.openrouterImagePrompt || "";
    $("s-gemini-image-prompt").value = settings.geminiImagePrompt || "";
    const template = settings.openrouterImageTemplate || "";
    $("s-template-preview").hidden = !template;
    if (template) $("s-template-preview").src = template;
    else $("s-template-preview").removeAttribute("src");
  };

  $("btn-ai-check").onclick = async () => {
    status("settings-status", "Проверяю связь…");
    try {
      const result = await api("POST", "api/admin/settings/ai-check", {
        aiProxyUrl: $("s-proxy").value.trim(),
      });
      const via = result.viaProxy ? "через прокси" : "напрямую";
      if (result.ok) status("settings-status", `ИИ отвечает ${via} ✓ (${result.ms} мс)`);
      else status("settings-status", `Нет связи ${via}: ${result.error}`, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = {
      siteTitle: $("s-title").value,
      siteDescription: $("s-description").value,
      textModel: $("s-model").value.trim(),
      sttModel: $("s-stt-model").value.trim(),
      textBaseUrl: $("s-base-url").value.trim(),
      aiProxyUrl: $("s-proxy").value.trim(),
      googleCseCx: $("s-google-cx").value.trim(),
      geminiImageModel: $("s-gemini-model").value.trim(),
      imageProvider: $("s-image-provider").value,
      openrouterImageModel: $("s-openrouter-image-model").value.trim(),
      openrouterImagePrompt: $("s-openrouter-image-prompt").value.trim(),
      geminiImagePrompt: $("s-gemini-image-prompt").value.trim(),
      geminiVisionModel: $("s-gemini-vision-model").value.trim(),
    };
    if ($("s-key").value) payload.textApiKey = $("s-key").value;
    if ($("s-openrouter-key").value) payload.openrouterKey = $("s-openrouter-key").value;
    if ($("s-google-key").value) payload.googleCseKey = $("s-google-key").value;
    if ($("s-gemini-key").value) payload.geminiKey = $("s-gemini-key").value;
    try {
      await api("PUT", "api/admin/settings", payload);
      await refresh();
      status("settings-status", "Настройки сохранены ✓", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  });

  $("btn-key-clear").onclick = async () => {
    const ok = await window.nrgConfirm({
      title: "Убрать ключ STT?",
      message: "Распознавание голоса перестанет работать, пока не задан новый OpenRouter ключ.",
      details: ["Ключ не сохраняется в журнале — откатить не получится"],
      confirmText: "Убрать ключ",
    });
    if (!ok) return;
    try {
      await api("PUT", "api/admin/settings", { openrouterKey: "" });
      await refresh();
      status("settings-status", "Ключ убран", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("btn-text-key-clear").onclick = async () => {
    const ok = await window.nrgConfirm({
      title: "Убрать ключ разбора?",
      message: "Разбор текста перестанет работать, пока не задан новый ключ.",
      confirmText: "Убрать ключ",
    });
    if (!ok) return;
    try {
      await api("PUT", "api/admin/settings", { textApiKey: "" });
      await refresh();
      status("settings-status", "Ключ разбора убран", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("btn-photo-check").onclick = async () => {
    status("settings-status", "Проверяю Google CSE… (1 запрос из квоты)");
    try {
      const result = await api("POST", "api/admin/settings/photo-check", {
        googleCseKey: $("s-google-key").value,
        googleCseCx: $("s-google-cx").value.trim(),
      });
      if (result.ok) status("settings-status", `Google CSE отвечает ✓ (${result.ms} мс, фото: ${result.count})`);
      else status("settings-status", `Google CSE не отвечает: ${result.error}`, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("btn-google-key-clear").onclick = async () => {
    const ok = await window.nrgConfirm({
      title: "Убрать ключ Google?",
      message: "Поиск фото продолжит работать через Open Food Facts + Wikimedia, но без Google.",
      details: ["Ключ не сохраняется в журнале — откатить не получится"],
      confirmText: "Убрать ключ",
    });
    if (!ok) return;
    try {
      await api("PUT", "api/admin/settings", { googleCseKey: "" });
      await refresh();
      status("settings-status", "Ключ Google убран", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("btn-gemini-check").onclick = async () => {
    status("settings-status", "Проверяю Gemini… (генерации нет, квота картинок не тратится)");
    try {
      const result = await api("POST", "api/admin/settings/gemini-check", {
        geminiKey: $("s-gemini-key").value,
        geminiModel: $("s-gemini-model").value.trim(),
      });
      if (result.ok) status("settings-status", `Gemini отвечает ✓ (${result.ms} мс, модель: ${result.model})`);
      else status("settings-status", `Gemini не отвечает: ${result.error}`, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("btn-gemini-key-clear").onclick = async () => {
    const ok = await window.nrgConfirm({
      title: "Убрать ключ Gemini?",
      message: "Перерисовка фото на белом фоне перестанет работать.",
      details: ["Ключ не сохраняется в журнале — откатить не получится"],
      confirmText: "Убрать ключ",
    });
    if (!ok) return;
    try {
      await api("PUT", "api/admin/settings", { geminiKey: "" });
      await refresh();
      status("settings-status", "Ключ Gemini убран", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("btn-prompts-clear").onclick = async () => {
    const ok = await window.nrgConfirm({
      title: "Сбросить промпты?",
      message: "Оба промпта генерации вернутся к стандартным.",
      details: ["Промпт OpenRouter и промпт Gemini будут очищены — генерация пойдёт со встроенным текстом"],
      confirmText: "Сбросить",
    });
    if (!ok) return;
    try {
      await api("PUT", "api/admin/settings", { openrouterImagePrompt: "", geminiImagePrompt: "" });
      await refresh();
      status("settings-status", "Промпты сброшены к стандартным", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  $("s-template-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      status("settings-status", "Загружаю шаблон…");
      const dataUrl = await fileToOriginalDataUrl(file);
      await api("POST", "api/admin/settings/image-template", { dataUrl });
      await refresh();
      status("settings-status", "Фото-шаблон обновлён ✓", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    } finally {
      event.target.value = "";
    }
  });

  $("btn-template-clear").onclick = async () => {
    const ok = await window.nrgConfirm({
      title: "Сбросить шаблон?",
      message: "Генерация пойдёт без фото-шаблона: форму и ракурс опишет промпт.",
      confirmText: "Сбросить",
    });
    if (!ok) return;
    try {
      await api("DELETE", "api/admin/settings/image-template");
      await refresh();
      status("settings-status", "Фото-шаблон сброшен", false, true);
    } catch (error) {
      status("settings-status", error.message, true);
    }
  };

  /* ---------- audit ---------- */
  // Старые записи (до нового формата) не имеют summary — описываем их по коду действия.
  const LEGACY_ACTIONS = {
    "drink.create": "Добавил напиток",
    "drink.update": "Изменил напиток",
    "drink.delete": "Удалил напиток",
    "drink.reprocess": "Переобработал картинку",
    "rating.set": "Поставил оценку",
    "rating.delete": "Удалил оценку",
    "tier.create": "Создал тир",
    "tier.update": "Изменил тир",
    "tier.delete": "Удалил тир",
    "user.create": "Создал пользователя",
    "user.update": "Изменил пользователя",
    "user.password": "Сбросил пароль",
    "user.delete": "Удалил пользователя",
    "settings.update": "Изменил настройки",
    "ai.parse": "Разобрал текст через ИИ",
    "audit.undo": "Откатил действие",
  };
  const ENTITY_NAMES = { drink: "напиток", rating: "оценка", tier: "тир", user: "пользователь", settings: "настройки" };

  const actionKind = (action) => {
    if (action === "audit.undo") return "undo";
    if (/\.(create|set)$/.test(action)) return "create";
    if (/\.delete$/.test(action)) return "delete";
    return "update";
  };
  const KIND_ICONS = { create: "+", delete: "−", update: "✎", undo: "↺" };

  // SQLite хранит «YYYY-MM-DD HH:MM:SS» в UTC — доводим до ISO, но не ломаем уже ISO с Z.
  const parseUtc = (value) => {
    const text = String(value || "").trim();
    if (!text) return new Date(NaN);
    const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}Z`;
    return new Date(iso);
  };
  const dayLabel = (date) => {
    if (Number.isNaN(date.getTime())) return "—";
    const today = new Date();
    const yesterday = new Date(Date.now() - 86_400_000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(date, today)) return "Сегодня";
    if (same(date, yesterday)) return "Вчера";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
  };

  const legacySummary = (row) => {
    const base = LEGACY_ACTIONS[row.action.replace(/^admin\./, "")] || row.action;
    const target = row.entityId ? ` ${ENTITY_NAMES[row.entity] || row.entity} ${row.entityId}` : "";
    return `${base}${target}`;
  };

  const legacyDetails = (details) =>
    String(details || "")
      .replace(/\buser=(\d+)/g, (_, id) => {
        const user = state.data.users.find((item) => item.id === Number(id));
        return `пользователь: ${user ? user.displayName : `#${id}`}`;
      })
      .replace(/\btier=/g, "тир: ")
      .replace(/\brole=/g, "роль: ")
      .replace(/\bactive=(true|false)/g, (_, v) => `доступ: ${v === "true" ? "активен" : "отключён"}`)
      .replace(/\bpublic=(true|false)/g, (_, v) => `на сайте: ${v === "true" ? "да" : "нет"}`)
      .replace(/\blogin=/g, "логин: ");

  const auditRowHtml = (row) => {
    const kind = actionKind(row.action);
    const date = parseUtc(row.createdAt);
    const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const summary = row.summary || legacySummary(row);
    const details = (row.summary ? row.details : legacyDetails(row.details))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const tags = [];
    if (row.undoneAt) {
      tags.push(`откачено${row.undoneBy ? ` · ${esc(row.undoneBy)}` : ""} · ${parseUtc(row.undoneAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`);
    }
    if (row.undoOf) tags.push(`отмена записи #${row.undoOf}`);
    let action = "";
    if (row.canUndo) action = `<button class="btn btn--ghost" type="button" data-undo="${row.id}">↺ Откатить</button>`;
    else if (row.undoable && !row.undoneAt && !row.undoOf) {
      action = `<span class="admin-hint" title="Объект менялся позже — сначала откатите более свежие записи">позже менялось</span>`;
    }
    return `
      <li class="audit-item ${row.undoneAt ? "is-undone" : ""}">
        <span class="audit-item__time" title="${esc(date.toLocaleString("ru-RU"))} · запись #${row.id}">${esc(time)}</span>
        <span class="audit-item__icon audit-item__icon--${kind}" aria-hidden="true">${KIND_ICONS[kind]}</span>
        <div>
          <div class="audit-item__summary"><span class="audit-item__who">${esc(row.displayName || row.username || "система")}</span> ${esc(summary.charAt(0).toLowerCase() + summary.slice(1))}</div>
          ${details.length ? `<ul class="audit-item__details">${details.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
          ${tags.map((tag) => `<span class="audit-item__tag">${tag}</span>`).join(" ")}
        </div>
        <div>${action}</div>
      </li>`;
  };

  const renderAudit = () => {
    const all = (state.data.audit || []).filter((row) => row.action !== "ai.parse");
    if (!all.length) {
      $("audit-table").innerHTML = `<p class="admin-hint">Журнал пуст или недоступен (нужна роль admin).</p>`;
      return;
    }
    const query = $("audit-search").value.trim().toLowerCase();
    const entity = $("audit-filter").value;
    const rows = all.filter((row) => {
      if (entity && row.entity !== entity) return false;
      if (!query) return true;
      return [row.summary || legacySummary(row), row.details, row.displayName, row.username]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    if (!rows.length) {
      $("audit-table").innerHTML = `<p class="admin-hint">Ничего не нашлось.</p>`;
      return;
    }
    const groups = [];
    for (const row of rows) {
      const label = dayLabel(parseUtc(row.createdAt));
      if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
      groups.at(-1).rows.push(row);
    }
    $("audit-table").innerHTML = groups
      .map(
        (group) => `
        <h3 class="audit-day">${esc(group.label)}</h3>
        <ul class="audit-list">${group.rows.map(auditRowHtml).join("")}</ul>`,
      )
      .join("");

    $("audit-table").querySelectorAll("[data-undo]").forEach((button) => {
      button.onclick = async () => {
        const row = state.data.audit.find((item) => item.id === Number(button.dataset.undo));
        const ok = await window.nrgConfirm({
          title: "Откатить действие?",
          message: `${row.displayName || row.username || "Система"}: ${row.summary}`,
          details: [
            ...String(row.details || "").split("\n").filter(Boolean).slice(0, 6),
            "Объект вернётся в состояние до этого действия",
          ],
          confirmText: "Откатить",
          danger: false,
        });
        if (!ok) return;
        button.disabled = true;
        try {
          const { notes } = await api("POST", `api/admin/audit/${row.id}/undo`, {});
          await refresh();
          status("global-status", `Откачено ✓${notes?.length ? ` (${notes.join("; ")})` : ""}`, false, true);
        } catch (error) {
          button.disabled = false;
          status("global-status", error.message, true);
        }
      };
    });
  };

  $("audit-search").addEventListener("input", () => renderAudit());
  $("audit-filter").addEventListener("change", () => renderAudit());

  /* ---------- логи (ИИ/STT и ошибки) ---------- */
  const LOG_ICONS = { ai: "◆", error: "!" };

  const logRowHtml = (row) => {
    const kind = row.entity === "error" ? "error" : "ai";
    const date = parseUtc(row.createdAt);
    const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const details = String(row.details || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return `
      <li class="audit-item">
        <span class="audit-item__time" title="${esc(date.toLocaleString("ru-RU"))} · запись #${row.id}">${esc(time)}</span>
        <span class="audit-item__icon audit-item__icon--${kind}" aria-hidden="true">${LOG_ICONS[kind]}</span>
        <div>
          <div class="audit-item__summary"><span class="audit-item__who">${esc(row.displayName || row.username || "система")}</span> ${esc(row.summary || row.action)}</div>
          ${details.length ? `<ul class="audit-item__details">${details.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : ""}
        </div>
        <div></div>
      </li>`;
  };

  const renderLogs = () => {
    const all = state.data.logs || [];
    const query = $("logs-search").value.trim().toLowerCase();
    const kind = $("logs-filter").value;
    const rows = all.filter((row) => {
      if (kind && row.entity !== kind) return false;
      if (!query) return true;
      return [row.summary, row.details, row.displayName, row.username]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
    if (!rows.length) {
      $("logs-table").innerHTML = `<p class="admin-hint">Пока пусто.</p>`;
      return;
    }
    const groups = [];
    for (const row of rows) {
      const label = dayLabel(parseUtc(row.createdAt));
      if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
      groups.at(-1).rows.push(row);
    }
    $("logs-table").innerHTML = groups
      .map(
        (group) => `
        <h3 class="audit-day">${esc(group.label)}</h3>
        <ul class="audit-list">${group.rows.map(logRowHtml).join("")}</ul>`,
      )
      .join("");
  };

  $("logs-search").addEventListener("input", () => renderLogs());
  $("logs-filter").addEventListener("change", () => renderLogs());

  /* ---------- статистика ---------- */
  const TIER_COLORS = { S: "#ff5f5a", A: "#f1a653", B: "#e7d471", C: "#8ebd93", D: "#8093b7" };
  const AI_KINDS = { parse: "Разбор текста", stt: "Распознавание речи", cleanup: "Чистка речи ИИ", redraw: "Перерисовка фото" };
  // Точной цены у Whisper нет (тариф по длительности, не по токенам) — не показываем «$0.0000».
  const aiCostLabel = (row) =>
    row.costUsd > 0 ? fmtCost(row.costUsd) : row.kind === "stt" ? "по длит." : "—";

  const safeColor = (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : fallback);

  const wordForm = (value, forms) => {
    const n = Math.abs(value) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 > 1 && n1 < 5) return forms[1];
    if (n1 === 1) return forms[0];
    return forms[2];
  };

  const parseDbTime = (value) => {
    const text = String(value || "").trim();
    if (!text) return 0;
    const iso = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}Z`;
    return Date.parse(iso) || 0;
  };

  const timeAgo = (value) => {
    const ts = parseDbTime(value);
    if (!ts) return "—";
    const minutes = Math.round((Date.now() - ts) / 60000);
    if (minutes < 1) return "только что";
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ч назад`;
    const days = Math.round(hours / 24);
    return days === 1 ? "вчера" : `${days} дн назад`;
  };

  const fmtNumber = (value) => new Intl.NumberFormat("ru-RU").format(value || 0);

  const fmtCost = (usd) => {
    const value = Number(usd) || 0;
    return "$" + (value >= 100 ? value.toFixed(2) : value >= 1 ? value.toFixed(3) : value.toFixed(4));
  };

  // Столбики по дням: оценки — жёлтая часть, новые банки — оранжевая сверху.
  const barsChart = (days) => {
    const W = 1100;
    const H = 210;
    const left = 30;
    const bottom = 26;
    const top = 12;
    const innerW = W - left - 10;
    const innerH = H - bottom - top;
    const max = Math.max(1, ...days.map((day) => day.ratings + day.drinks));
    const step = innerW / days.length;
    const barW = Math.max(3, Math.min(18, step * 0.62));
    const bars = days
      .map((day, index) => {
        const x = left + index * step + (step - barW) / 2;
        const total = day.ratings + day.drinks;
        const height = (total / max) * innerH;
        const drinksH = total ? (day.drinks / total) * height : 0;
        const ratingsH = Math.max(0, height - drinksH);
        const y = H - bottom - height;
        const result =
          ratingsH > 0
            ? `<rect x="${x.toFixed(1)}" y="${(y + drinksH).toFixed(1)}" width="${barW.toFixed(1)}" height="${ratingsH.toFixed(1)}" rx="2" fill="url(#statsBars)"><title>${day.label}: ${day.ratings} ${wordForm(day.ratings, ["оценка", "оценки", "оценок"])}</title></rect>`
            : "";
        const drinks =
          drinksH > 0
            ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${drinksH.toFixed(1)}" rx="2" fill="#ff7448"><title>${day.label}: новых банок ${day.drinks}</title></rect>`
            : "";
        return result + drinks;
      })
      .join("");
    const labelEvery = Math.ceil(days.length / 8);
    const labels = days
      .map((day, index) =>
        index % labelEvery === 0
          ? `<text x="${(left + index * step + step / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="rgba(255,255,255,.42)">${day.label}</text>`
          : "",
      )
      .join("");
    const grid = [...new Set([0, Math.round(max / 2), max])]
      .map((value) => {
        const y = H - bottom - (value / max) * innerH;
        return `<line x1="${left}" x2="${W - 10}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.07)"/><text x="${left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,.35)">${value}</text>`;
      })
      .join("");
    return `<svg class="stats-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Оценки и новые банки по дням">
      <defs><linearGradient id="statsBars" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#efee87" stop-opacity=".3"/><stop offset="1" stop-color="#efee87"/>
      </linearGradient></defs>
      ${grid}${bars}${labels}
    </svg>`;
  };

  // Накопительный рост оценок за период — мягкая линия с заливкой.
  const areaChart = (days) => {
    const W = 1100;
    const H = 190;
    const left = 30;
    const bottom = 22;
    const top = 12;
    const innerW = W - left - 10;
    const innerH = H - bottom - top;
    let acc = 0;
    const values = days.map((day) => (acc += day.ratings));
    const max = Math.max(1, ...values);
    const points = values.map((value, index) => [
      left + (days.length === 1 ? innerW / 2 : (index / (days.length - 1)) * innerW),
      top + innerH - (value / max) * innerH,
    ]);
    const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const area = `${line} L${points.at(-1)[0].toFixed(1)} ${H - bottom} L${points[0][0].toFixed(1)} ${H - bottom} Z`;
    const labelIndexes = [0, Math.floor((days.length - 1) / 2), days.length - 1].filter(
      (value, index, list) => list.indexOf(value) === index,
    );
    const labels = labelIndexes
      .map((index) => {
        const x = left + (days.length === 1 ? innerW / 2 : (index / (days.length - 1)) * innerW);
        return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="rgba(255,255,255,.42)">${days[index].label}</text>`;
      })
      .join("");
    const last = points.at(-1);
    return `<svg class="stats-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Накопительный рост оценок">
      <defs><linearGradient id="statsArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8ebd93" stop-opacity=".45"/><stop offset="1" stop-color="#8ebd93" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#statsArea)"/>
      <path d="${line}" fill="none" stroke="#8ebd93" stroke-width="2"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="#efee87"/>
      <text x="${last[0].toFixed(1)}" y="${(last[1] - 8).toFixed(1)}" text-anchor="end" fill="rgba(255,255,255,.7)">${values.at(-1)}</text>
      ${labels}
    </svg>`;
  };

  const donutChart = (tiers, total) => {
    const radius = 54;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    const segments = tiers
      .filter((tier) => tier.count > 0)
      .map((tier) => {
        const length = (tier.count / total) * circumference;
        const segment = `<circle cx="70" cy="70" r="${radius}" fill="none" stroke="${safeColor(TIER_COLORS[tier.tier], "#ff4f79")}" stroke-width="14" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 70 70)"><title>${tier.tier}: ${tier.count}</title></circle>`;
        offset += length;
        return segment;
      })
      .join("");
    return `<svg viewBox="0 0 140 140" class="stats-donut__svg" role="img" aria-label="Распределение тиров">
      <circle cx="70" cy="70" r="${radius}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="14"/>
      ${segments}
      <text x="70" y="70" text-anchor="middle" class="stats-donut__total">${total}</text>
      <text x="70" y="86" text-anchor="middle" class="stats-donut__caption">ОЦЕНОК</text>
    </svg>`;
  };

  const heatmapGrid = (cells) => {
    const byKey = new Map(cells.map((cell) => [`${cell.w}:${cell.h}`, cell.n]));
    const max = Math.max(1, ...cells.map((cell) => cell.n));
    const order = [1, 2, 3, 4, 5, 6, 0];
    const names = { 1: "пн", 2: "вт", 3: "ср", 4: "чт", 5: "пт", 6: "сб", 0: "вс" };
    const head = `<span class="stats-heat__label"></span>${Array.from(
      { length: 24 },
      (_, hour) => `<span class="stats-heat__hour">${hour % 3 === 0 ? hour : ""}</span>`,
    ).join("")}`;
    const rows = order
      .map((weekday) => {
        const squares = Array.from({ length: 24 }, (_, hour) => {
          const count = byKey.get(`${weekday}:${hour}`) || 0;
          const label = `${names[weekday]} ${String(hour).padStart(2, "0")}:00 — ${count} ${wordForm(count, ["событие", "события", "событий"])}`;
          return `<span class="heat-cell" style="--heat:${Number((count / max).toFixed(2))}" title="${esc(label)}"></span>`;
        }).join("");
        return `<span class="stats-heat__label">${names[weekday]}</span>${squares}`;
      })
      .join("");
    return `<div class="stats-heat">${head}${rows}</div>`;
  };

  const topDrinksList = (drinks) => {
    const max = Math.max(1, ...drinks.map((drink) => drink.votes));
    return `<div class="stats-top">${drinks
      .map(
        (drink, index) => `
        <div class="stats-top__row">
          <span class="stats-top__rank">${index + 1}</span>
          <img src="${esc(drink.image)}" alt="" loading="lazy">
          <div class="stats-top__main"><b title="${esc(drink.name)}">${esc(drink.name)}</b><small>${esc([drink.brand, drink.flavor].filter(Boolean).join(" · "))}${drink.published ? "" : " · скрыт"}</small></div>
          <span class="stats-top__bar"><i style="width:${Number(((drink.votes / max) * 100).toFixed(1))}%"></i></span>
          <span class="stats-top__value">${drink.votes} ${wordForm(drink.votes, ["оценка", "оценки", "оценок"])}${drink.avgScore ? ` · ${Number(drink.avgScore).toFixed(1).replace(".", ",")}` : ""}</span>
        </div>`,
      )
      .join("")}</div>`;
  };

  const topUsersList = (users) => {
    const max = Math.max(1, ...users.map((user) => user.ratings + user.added));
    return `<div class="stats-top">${users
      .map(
        (user, index) => `
        <div class="stats-top__row">
          <span class="stats-top__rank">${index + 1}</span>
          <span class="stats-avatar" style="--person-color:${safeColor(user.color, "#9fb7ff")}">${esc(user.initials)}</span>
          <div class="stats-top__main"><b>${esc(user.name)}</b><small>${user.reviews} ${wordForm(user.reviews, ["отзыв", "отзыва", "отзывов"])} · ${user.added} ${wordForm(user.added, ["банка", "банки", "банок"])}${user.lastSeen ? ` · был ${timeAgo(user.lastSeen)}` : ""}</small></div>
          <span class="stats-top__bar"><i style="width:${Number((((user.ratings + user.added) / max) * 100).toFixed(1))}%"></i></span>
          <span class="stats-top__value">${user.ratings} ${wordForm(user.ratings, ["оценка", "оценки", "оценок"])}</span>
        </div>`,
      )
      .join("")}</div>`;
  };

  const onlineMarkup = (online) =>
    online.length
      ? `<div class="stats-online">${online
          .map(
            (user) => `
          <div class="stats-online__row">
            <span class="stats-online__dot"></span>
            <span class="stats-avatar" style="--person-color:${safeColor(user.color, "#9fb7ff")}">${esc(user.initials)}</span>
            <div class="stats-online__main">
              <b>${esc(user.name)}</b>
              <small>${esc(user.device)}${user.ip ? ` · ${esc(user.ip)}` : ""}</small>
            </div>
            <span class="stats-online__time">${timeAgo(user.lastSeen)}</span>
          </div>`,
          )
          .join("")}</div>`
      : `<p class="stats-empty">Сейчас никого — все офлайн.</p>`;

  const recentMarkup = (recent) =>
    recent.length
      ? `<ul class="audit-list">${recent
          .map((row) => {
            const kind = row.action.includes("create")
              ? "create"
              : row.action.includes("delete")
                ? "delete"
                : row.action.includes("undo")
                  ? "undo"
                  : "update";
            const icon = { create: "+", delete: "×", update: "✎", undo: "↺" }[kind];
            return `
            <li class="audit-item">
              <span class="audit-item__time">${timeAgo(row.at)}</span>
              <span class="audit-item__icon audit-item__icon--${kind}">${icon}</span>
              <div>
                <b class="audit-item__who">${esc(row.who)}</b>
                <p class="audit-item__summary">${esc(row.summary)}</p>
              </div>
            </li>`;
          })
          .join("")}</ul>`
      : `<p class="stats-empty">Журнал пока пуст.</p>`;

  const statCard = (label, value, note, extra = "") => `
    <div class="stats-card${extra}">
      <span>${label}</span>
      ${typeof value === "number" ? `<b data-count="${Number(value)}">0</b>` : `<b>${value}</b>`}
      <small>${note}</small>
    </div>`;

  const renderStats = () => {
    const data = state.stats;
    if (!data) {
      $("stats-body").innerHTML = `<p class="stats-empty">Считаю статистику…</p>`;
      return;
    }
    const { totals, period, days, tiers, topDrinks, topUsers, online, recent } = data;
    const ai = data.ai || { kinds: [], models: [], allTime: { requests: 0, totalTokens: 0, costUsd: 0 } };
    const aiRequests = ai.kinds.reduce((sum, row) => sum + row.requests, 0);
    const aiCost = ai.kinds.reduce((sum, row) => sum + row.costUsd, 0);
    const totalRatings = tiers.reduce((sum, tier) => sum + tier.count, 0);
    $("stats-updated").textContent = `обновлено в ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} · онлайн считается за 15 минут`;
    $("stats-body").innerHTML = `
      <div class="stats-cards">
        ${statCard("Банки", totals.drinks, `${totals.published} опубликовано · ${totals.hidden} скрыто`)}
        ${statCard("Участники", totals.activeUsers, `${totals.sharedUsers} публичных профиля`)}
        ${statCard("Оценки", totals.ratings, `${totals.reviews} ${wordForm(totals.reviews, ["отзыв", "отзыва", "отзывов"])} с текстом`)}
        ${statCard("Средний балл", totals.avgScore === null ? "—" : String(totals.avgScore).replace(".", ","), `${String(totals.ratingsPerDrink).replace(".", ",")} оценки на банку`)}
        ${statCard("Онлайн", online.length, "за последние 15 минут", " stats-card--online")}
        ${statCard(`За ${data.period.days} дней`, `+${fmtNumber(period.ratings)}`, `оценок · ${period.drinks} банок · ${period.logins} заходов`)}
        ${statCard("ИИ-запросы", aiRequests, `${fmtCost(aiCost)} за период · всего ${fmtCost(ai.allTime.costUsd)}`)}
      </div>
      <div class="stats-grid">
        <div class="stats-panel stats-panel--wide">
          <div class="stats-panel__head"><h3>Активность по дням</h3><span class="admin-hint">${period.events} событий за период${period.bestDay ? ` · пик: ${period.bestDay.label} (${period.bestDay.events})` : ""}</span></div>
          ${barsChart(days)}
          <div class="stats-legend">
            <span><i style="background:#efee87"></i>оценки</span>
            <span><i style="background:#ff7448"></i>новые банки</span>
            <span>заходы: ${period.logins}${period.failures ? ` · неудачных: ${period.failures}` : ""}</span>
          </div>
        </div>
        <div class="stats-panel">
          <div class="stats-panel__head"><h3>Рост оценок</h3><span class="admin-hint">накопительно за ${data.period.days} дней</span></div>
          ${areaChart(days)}
        </div>
        <div class="stats-panel">
          <div class="stats-panel__head"><h3>Онлайн сейчас</h3><span class="admin-hint">${online.length} ${wordForm(online.length, ["человек", "человека", "человек"])}</span></div>
          ${onlineMarkup(online)}
        </div>
        <div class="stats-panel">
          <div class="stats-panel__head"><h3>Распределение тиров</h3><span class="admin-hint">${fmtNumber(totalRatings)} оценок всего</span></div>
          ${
            totalRatings
              ? `<div class="stats-donut">${donutChart(tiers, totalRatings)}<div class="stats-donut__legend">${tiers
                  .map(
                    (tier) => `
                  <div class="stats-donut__row">
                    <i style="background:${safeColor(TIER_COLORS[tier.tier], "#ff4f79")}"></i>
                    <span>${esc(tier.tier)}${tier.score ? ` · ${tier.score}` : ""}</span>
                    <b>${tier.count}${totalRatings ? ` · ${Math.round((tier.count / totalRatings) * 100)}%` : ""}</b>
                  </div>`,
                  )
                  .join("")}</div></div>`
              : `<p class="stats-empty">Оценок ещё нет.</p>`
          }
        </div>
        <div class="stats-panel">
          <div class="stats-panel__head"><h3>Топ банок</h3><span class="admin-hint">по числу оценок</span></div>
          ${topDrinks.length ? topDrinksList(topDrinks) : `<p class="stats-empty">Пока никто ничего не оценил.</p>`}
        </div>
        <div class="stats-panel">
          <div class="stats-panel__head"><h3>Топ участников</h3><span class="admin-hint">оценки и добавленные банки</span></div>
          ${topUsers.length ? topUsersList(topUsers) : `<p class="stats-empty">Пока пусто.</p>`}
        </div>
        <div class="stats-panel stats-panel--wide">
          <div class="stats-panel__head"><h3>ИИ: запросы и трата</h3><span class="admin-hint">за ${data.period.days} дней · цены оценочные, кроме отчёта провайдера</span></div>
          ${
            ai.kinds.length
              ? `<div class="stats-ai">
            ${ai.kinds
              .map(
                (row) => `
              <div class="stats-ai__row">
                <b>${esc(AI_KINDS[row.kind] || row.kind)}</b>
                <span>${fmtNumber(row.requests)} ${wordForm(row.requests, ["запрос", "запроса", "запросов"])}</span>
                <span>${row.totalTokens ? `${fmtNumber(row.totalTokens)} ток.` : "без счётчика"}</span>
                <b>${aiCostLabel(row)}</b>
              </div>`,
              )
              .join("")}
            ${
              ai.models.length
                ? `<div class="stats-ai__models">${ai.models
                    .map(
                      (model) =>
                        `<span>${esc(model.model)}: ${fmtNumber(model.requests)} · ${fmtNumber(model.totalTokens)} ток. · ${fmtCost(model.costUsd)}</span>`,
                    )
                    .join("")}</div>`
                : ""
            }
          </div>`
              : `<p class="stats-empty">ИИ пока не звали.</p>`
          }
        </div>
        <div class="stats-panel stats-panel--wide">
          <div class="stats-panel__head"><h3>Когда что-то происходит</h3><span class="admin-hint">журнал за 90 дней · будни × часы</span></div>
          ${heatmapGrid(data.heatmap)}
        </div>
        <div class="stats-panel stats-panel--wide">
          <div class="stats-panel__head"><h3>Последние изменения</h3><span class="admin-hint">${recent[0] ? `самое свежее — ${timeAgo(recent[0].at)}` : "пока ничего"}</span></div>
          ${recentMarkup(recent)}
        </div>
      </div>`;
    window.nrgCountUp?.($("stats-body"));
  };

  const loadStats = async ({ refresh = false } = {}) => {
    if (!refresh && state.stats && state.stats.period.days === state.statsDays) {
      renderStats();
      return;
    }
    try {
      state.stats = await api("GET", `api/admin/stats?days=${state.statsDays}`);
      renderStats();
    } catch (error) {
      status("global-status", error.message, true);
    }
  };

  $("stats-period").addEventListener("click", (event) => {
    const button = event.target.closest("[data-days]");
    if (!button) return;
    state.statsDays = Number(button.dataset.days);
    document
      .querySelectorAll("#stats-period [data-days]")
      .forEach((item) => item.classList.toggle("is-active", item === button));
    state.stats = null;
    loadStats();
  });

  // Раз в минуту обновляем только если открыта вкладка статистики: онлайн не застывает.
  setInterval(() => {
    if (state.tab === "stats" && document.visibilityState === "visible") loadStats({ refresh: true });
  }, 60_000);

  /* ---------- база данных ---------- */
  const DB_NOTES = {
    users: "участники, роли, вход",
    sessions: "сессии входа (токен sha256)",
    tiers: "тиры S–D и баллы",
    drinks: "банки индекса",
    drink_relations: "связи «похожих» банок",
    ratings: "оценки: тир + отзыв",
    settings: "настройки ключ → значение",
    audit_log: "журнал действий и откатов",
    login_attempts: "попытки входа (антибрутфорс)",
    ai_usage: "ИИ-запросы: токены и цена",
  };
  // Раскладка карты: таблица → [колонка]. Порядок в колонке — по строкам ниже.
  const DB_LAYOUT = {
    sessions: [0, 0],
    users: [0, 1],
    ai_usage: [0, 2],
    audit_log: [0, 3],
    tiers: [1, 0],
    ratings: [1, 1],
    settings: [2, 0],
    drinks: [2, 1],
    drink_relations: [2, 2],
    login_attempts: [2, 3],
  };
  const fmtBytes = (bytes) =>
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`
      : `${fmtNumber(Math.max(1, Math.round(bytes / 1024)))} КБ`;

  const dbCard = (table) => {
    const fkByColumn = new Map(table.foreignKeys.map((fk) => [fk.column, fk]));
    const rows = table.columns
      .map((column) => {
        const fk = fkByColumn.get(column.name);
        return `
        <li${fk ? ` title="${esc(`ссылка на ${fk.table}.${fk.columnTo}`)}"` : ""}>
          <code>${esc(column.name)}</code>
          ${column.pk ? `<i class="db-badge db-badge--pk">PK</i>` : ""}
          ${fk ? `<i class="db-badge db-badge--fk">FK</i>` : ""}
          ${column.unique && !column.pk ? `<i class="db-badge db-badge--uq">U</i>` : ""}
          <span class="db-col__type">${esc(column.type)}</span>
        </li>`;
      })
      .join("");
    return `
      <article class="db-card" data-table="${esc(table.name)}">
        <div class="db-card__head">
          <b>${esc(table.name)}</b>
          <span class="db-card__rows" title="строк в таблице">${fmtNumber(table.count)}</span>
        </div>
        <p class="db-card__note">${esc(DB_NOTES[table.name] || "таблица базы")}</p>
        <ul class="db-cols">${rows}</ul>
      </article>`;
  };

  const drawDbLinks = (cardByTable) => {
    const rels = [];
    for (const table of state.database.tables) {
      for (const fk of table.foreignKeys) {
        rels.push({
          from: table.name,
          fromColumn: fk.column,
          to: fk.table,
          toColumn: fk.columnTo,
          nullable: fk.onDelete === "SET NULL",
        });
      }
    }
    const pairTotal = new Map();
    for (const rel of rels) {
      const key = `${rel.from}→${rel.to}`;
      pairTotal.set(key, (pairTotal.get(key) || 0) + 1);
    }
    const pairSeen = new Map();
    const paths = [];
    const n = (value) => value.toFixed(1);
    for (const rel of rels) {
      const fromCard = cardByTable.get(rel.from);
      const toCard = cardByTable.get(rel.to);
      if (!fromCard || !toCard) continue;
      const key = `${rel.from}→${rel.to}`;
      const index = pairSeen.get(key) || 0;
      pairSeen.set(key, index + 1);
      const shift = (index - (pairTotal.get(key) - 1) / 2) * 22;
      const a = { x: fromCard.offsetLeft, y: fromCard.offsetTop, w: fromCard.offsetWidth, h: fromCard.offsetHeight };
      const b = { x: toCard.offsetLeft, y: toCard.offsetTop, w: toCard.offsetWidth, h: toCard.offsetHeight };
      const dx = b.x + b.w / 2 - (a.x + a.w / 2);
      const dy = b.y + b.h / 2 - (a.y + a.h / 2);
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      let p1;
      let p2;
      let c1;
      let c2;
      if (Math.abs(dx) >= Math.abs(dy)) {
        p1 = { x: a.x + (dx > 0 ? a.w : 0), y: clamp(a.y + a.h / 2 + shift, a.y + 14, a.y + a.h - 14) };
        p2 = { x: b.x + (dx > 0 ? 0 : b.w), y: clamp(b.y + b.h / 2 + shift, b.y + 14, b.y + b.h - 14) };
        const bend = Math.max(36, Math.abs(p2.x - p1.x) * 0.4);
        c1 = { x: p1.x + (dx > 0 ? bend : -bend), y: p1.y };
        c2 = { x: p2.x + (dx > 0 ? -bend : bend), y: p2.y };
      } else {
        p1 = { x: clamp(a.x + a.w / 2 + shift, a.x + 14, a.x + a.w - 14), y: a.y + (dy > 0 ? a.h : 0) };
        p2 = { x: clamp(b.x + b.w / 2 + shift, b.x + 14, b.x + b.w - 14), y: b.y + (dy > 0 ? 0 : b.h) };
        const bend = Math.max(36, Math.abs(p2.y - p1.y) * 0.4);
        c1 = { x: p1.x, y: p1.y + (dy > 0 ? bend : -bend) };
        c2 = { x: p2.x, y: p2.y + (dy > 0 ? -bend : bend) };
      }
      paths.push(
        `<path class="db-link${rel.nullable ? " is-nullable" : ""}" d="M${n(p1.x)} ${n(p1.y)} C${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(p2.x)} ${n(p2.y)}" marker-end="url(#db-arrow)"><title>${esc(`${rel.from}.${rel.fromColumn} → ${rel.to}.${rel.toColumn}`)}</title></path>`,
      );
    }
    $("db-links").innerHTML = `
      <defs>
        <marker id="db-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L8 4 L0 8 Z" fill="rgba(242,237,228,.4)"></path>
        </marker>
      </defs>
      ${paths.join("")}`;
  };

  const layoutDbMap = () => {
    const map = $("db-map");
    const cards = [...map.querySelectorAll(".db-card")];
    if (!cards.length) return;
    const layout = { ...DB_LAYOUT };
    let extraRow = 0;
    for (const card of cards) {
      if (!layout[card.dataset.table]) layout[card.dataset.table] = [3, extraRow++];
    }
    const columns = Math.max(3, ...Object.values(layout).map(([col]) => col + 1));
    const gapX = 26;
    const gapY = 22;
    const width = Math.max(map.parentElement.clientWidth, 780);
    const colWidth = Math.floor((width - gapX * (columns - 1)) / columns);
    for (const card of cards) card.style.width = `${colWidth}px`;
    const ordered = [...cards].sort((a, b) => {
      const [ca, ra] = layout[a.dataset.table];
      const [cb, rb] = layout[b.dataset.table];
      return ca - cb || ra - rb;
    });
    const tops = new Array(columns).fill(0);
    for (const card of ordered) {
      const [col] = layout[card.dataset.table];
      card.style.left = `${col * (colWidth + gapX)}px`;
      card.style.top = `${tops[col]}px`;
      tops[col] += card.offsetHeight + gapY;
    }
    map.style.height = `${Math.max(0, ...tops) - gapY + 6}px`;
    drawDbLinks(new Map(cards.map((card) => [card.dataset.table, card])));
  };

  const renderDatabase = () => {
    const data = state.database;
    if (!data) {
      $("db-summary").textContent = "Собираю схему…";
      return;
    }
    const totalRows = data.tables.reduce((sum, table) => sum + table.count, 0);
    $("db-summary").textContent =
      `${data.tables.length} ${wordForm(data.tables.length, ["таблица", "таблицы", "таблиц"])} · ` +
      `${fmtNumber(totalRows)} ${wordForm(totalRows, ["запись", "записи", "записей"])} · ` +
      `${fmtBytes(data.sizeBytes)} · схема v${data.userVersion} · ` +
      `обновлено в ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
    const map = $("db-map");
    map.querySelectorAll(".db-card").forEach((card) => card.remove());
    map.insertAdjacentHTML("beforeend", data.tables.map(dbCard).join(""));
    layoutDbMap();
  };

  const loadDatabase = async ({ refresh = false } = {}) => {
    if (!refresh && state.database) {
      renderDatabase();
      return;
    }
    try {
      state.database = await api("GET", "api/admin/database");
      renderDatabase();
    } catch (error) {
      status("global-status", error.message, true);
    }
  };

  let dbResizeTimer = null;
  window.addEventListener("resize", () => {
    if (state.tab !== "database" || !state.database) return;
    clearTimeout(dbResizeTimer);
    dbResizeTimer = setTimeout(layoutDbMap, 150);
  });

  /* ---------- helpers ---------- */
  // В Nano Banana шлём исходник ДО вырезания фона и строго JPEG:
  // прозрачность кладём на белый, всё ужимаем до maxSide.
  const toJpegDataUrl = (dataUrl, maxSide = 1200) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", 0.92));
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error("Не удалось прочитать картинку"));
      img.src = dataUrl;
    });

  // PNG-версия для OpenRouter: прозрачность сохраняем, на белое не подкладываем.
  const toPngDataUrl = (dataUrl, maxSide = 1200) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/png"));
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error("Не удалось прочитать картинку"));
      img.src = dataUrl;
    });

  // Сохранённый путь (/uploads/…, /assets/…) или внешняя ссылка → dataURL.
  // Внешние идут через remoteImageToDataUrl (прямо + прокси), свои — обычным fetch.
  const pathToDataUrl = async (value) => {
    if (/^https?:\/\//i.test(value)) return remoteImageToDataUrl(value);
    const response = await fetch(value);
    if (!response.ok) throw new Error(`Не удалось загрузить картинку (HTTP ${response.status})`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("Ссылка ведёт не на изображение");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Не удалось прочитать картинку"));
      reader.readAsDataURL(blob);
    });
  };
  const fileToOriginalDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    });

  const fileToDataUrl = (file, maxSide) =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          const isPng = file.type === "image/png";
          resolve(canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.85));
        } catch (error) {
          reject(error);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("bad image"));
      };
      img.src = url;
    });

  /* ---------- init ---------- */
  $("btn-logout-admin").onclick = async () => {
    try {
      await api("POST", "api/auth/logout");
    } catch {
      /* игнорируем */
    }
    location.href = "/cabinet.html";
  };

  $("drinks-sort").addEventListener("change", (event) => {
    state.drinksSort = event.target.value;
    renderDrinks();
  });

  document.querySelectorAll("#admin-tabs .btn").forEach((button) => {
    button.onclick = () => switchTab(button.dataset.tab);
  });

  (async () => {
    try {
      const { user } = await api("GET", "api/auth/me");
      state.me = user;
    } catch {
      state.me = null;
    }
    if (!state.me || !["admin", "editor"].includes(state.me.role)) {
      location.href = "/";
      return;
    }
    $("admin-me").textContent = `${state.me.displayName} · ${state.me.role}`;
    if (state.me.role !== "admin") {
      document.querySelectorAll("[data-admin-only]").forEach((element) => {
        element.hidden = true;
      });
    }
    try {
      await loadData();
    } catch (error) {
      status("global-status", error.message, true);
      return;
    }
    document.title = `${state.data.settings.siteTitle || "NRG / INDEX"} — админка`;
    switchTab("drinks");
    // Диплинк с тирлиста: admin?drink=<slug> — сразу открываем форму правки.
    const slug = new URLSearchParams(location.search).get("drink");
    if (slug) {
      const drink = state.data.drinks.find((item) => item.slug === slug);
      history.replaceState(null, "", location.pathname);
      if (drink) openDrinkForm(drink.id);
    }
  })();
})();
