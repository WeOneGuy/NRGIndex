(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
    );
  const safeColor = (value, fallback) =>
    /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : fallback;
  const wordForm = (value, forms) => {
    const n = Math.abs(value) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 > 1 && n1 < 5) return forms[1];
    if (n1 === 1) return forms[0];
    return forms[2];
  };

  // Текстареа растёт/ужимается под текст: без внутреннего скролла и пустого места.
  // Обнуляем высоту перед замером — иначе scrollHeight упирается в текущую высоту.
  const autoGrow = (node, max = 420) => {
    if (!node) return;
    const cs = getComputedStyle(node);
    const line = parseFloat(cs.lineHeight) || 20;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + 2;
    node.style.minHeight = "0px";
    node.style.height = "0px";
    const h = Math.max(node.scrollHeight, line + pad);
    node.style.minHeight = "";
    node.style.height = Math.min(h, max) + "px";
    node.style.overflowY = h > max ? "auto" : "hidden";
  };

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
    if (!res.ok) {
      const error = new Error(
        json?.error || `Сервер ответил HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
      );
      error.status = res.status;
      error.code = json?.code || "";
      // 409 от защиты дублей приносит список похожих — его показываем в форме.
      error.payload = json;
      throw error;
    }
    return json;
  };

  const TIER_COLORS = { S: "#ff5f5a", A: "#f1a653", B: "#e7d471", C: "#8ebd93", D: "#8093b7" };
  const state = { me: null, summary: null, mine: [], addedSlugs: new Set() };
  const pending = {
    parsed: null,
    image: null,
    original: null, // необработанный оригинал для 🍌 (резаный с кривым фоном модель тупит)
    photoNote: "",
    photoSource: "auto",
    userPhoto: false,
    similarCount: 0, // сколько похожих банок нашёл ИИ
    duplicateAck: true, // «это не он» — без этого новую банку не сохраняем
    absenceAck: false, // «такого нет в списке» — подтверждение после неудачных поисков
    barcode: "",
    rawCode: "",
  };

  /* ---------- views ---------- */
  const showAuth = () => {
    $("boot-view").hidden = true;
    $("auth-view").hidden = false;
    $("password-view").hidden = true;
    $("cab-view").hidden = true;
  };
  const showPasswordChange = () => {
    $("boot-view").hidden = true;
    $("auth-view").hidden = true;
    $("password-view").hidden = false;
    $("cab-view").hidden = true;
  };

  const enterCabinet = async () => {
    $("boot-view").hidden = true;
    $("auth-view").hidden = true;
    $("password-view").hidden = true;
    $("cab-view").hidden = false;
    renderAvatars();
    $("me-name").textContent = state.me.displayName;
    $("me-role").textContent = state.me.title || state.me.role;
    if (state.me.role === "admin") $("admin-button").hidden = false;
    if (state.me.role === "admin" || state.me.role === "editor") $("admin-link").hidden = false;
    $("profile-link").href = `profile.html?u=${encodeURIComponent(state.me.username)}`;
    $("profile-link").hidden = !state.me.isPublic;
    await refreshAll();
    // Диплинк с тирлиста: cabinet.html?rate=<slug> — сразу открываем редактор мнения.
    const rateSlug = new URLSearchParams(location.search).get("rate");
    if (rateSlug) {
      history.replaceState(null, "", location.pathname);
      openOpinion(decodeURIComponent(rateSlug));
    }
  };

  /* ---------- вкладки кабинета ---------- */
  const switchCabTab = (tab) => {
    document.querySelectorAll("[data-cab-tab]").forEach((button) => {
      const active = button.dataset.cabTab === tab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("cab-panel-add").hidden = tab !== "add";
    $("cab-panel-mine").hidden = tab !== "mine";
  };

  document.querySelectorAll("[data-cab-tab]").forEach((button) => {
    button.addEventListener("click", () => switchCabTab(button.dataset.cabTab));
  });

  // Аватар в кабинете: кроп с зумом и сдвигом делаем на клиенте, сервер всё равно
  // приводит к 256×256. Превью — и в карточке профиля, и в блоке «Аккаунт».
  const setAvatarNode = (node, user) => {
    if (!node) return;
    node.style.setProperty("--person-color", safeColor(user?.color, "#fff"));
    if (user?.avatar) node.innerHTML = `<img src="${esc(user.avatar)}" alt="">`;
    else
      node.textContent =
        user?.initials || String(user?.displayName || "?").slice(0, 2).toUpperCase();
  };

  const renderAvatars = () => {
    setAvatarNode($("me-avatar"), state.me);
    setAvatarNode($("avatar-preview"), state.me);
    $("btn-avatar-remove").hidden = !state.me?.avatar;
    $("avatar-crop-remove").hidden = !state.me?.avatar;
  };

  const CROP_VIEW = 240; // сторона круга кропа, должна совпадать с CSS .avatar-crop
  const AVATAR_SIDE = 384; // квадрат перед отправкой; сервер сожмёт до 256
  const cropMath = window.nrgAvatarCrop;
  const crop = { img: null, zoom: 1, cx: 0, cy: 0 };
  let cropObjectUrl = "";
  let cropDrag = null;

  const setAvatarCropStatus = (message, isError = false) => {
    const node = $("avatar-crop-status");
    node.textContent = message;
    node.style.color = isError ? "#ff8a8a" : "";
  };

  const releaseCropObjectUrl = () => {
    if (cropObjectUrl) URL.revokeObjectURL(cropObjectUrl);
    cropObjectUrl = "";
  };

  const renderCrop = () => {
    if (!crop.img) return;
    // cropRect возвращает зажатый центр — синхронизируем состояние после драга
    const { side, x, y } = cropMath.cropRect(
      crop.img.naturalWidth,
      crop.img.naturalHeight,
      crop.zoom,
      crop.cx,
      crop.cy,
    );
    crop.cx = x + side / 2;
    crop.cy = y + side / 2;
    const scale = CROP_VIEW / side;
    const node = $("avatar-crop-img");
    node.style.width = `${crop.img.naturalWidth * scale}px`;
    node.style.height = `${crop.img.naturalHeight * scale}px`;
    node.style.left = `${CROP_VIEW / 2 - crop.cx * scale}px`;
    node.style.top = `${CROP_VIEW / 2 - crop.cy * scale}px`;
  };

  const resetCropUi = () => {
    crop.img = null;
    crop.zoom = 1;
    $("avatar-crop-img").removeAttribute("src");
    $("avatar-crop").hidden = true;
    $("avatar-zoom-row").hidden = true;
    $("avatar-save").disabled = true;
    $("avatar-crop-hint").hidden = false;
  };

  const setCropImage = (src) => {
    const img = new Image();
    img.onload = () => {
      crop.img = img;
      crop.zoom = 1;
      crop.cx = img.naturalWidth / 2;
      crop.cy = img.naturalHeight / 2;
      $("avatar-crop-img").src = src;
      $("avatar-crop").hidden = false;
      $("avatar-zoom-row").hidden = false;
      $("avatar-zoom").value = "1";
      $("avatar-save").disabled = false;
      $("avatar-crop-hint").hidden = true;
      renderCrop();
    };
    img.onerror = () => setAvatarCropStatus("не удалось прочитать картинку", true);
    img.src = src;
  };

  const setCropZoom = (value) => {
    if (!crop.img) return;
    crop.zoom = cropMath.clamp(Number(value) || 1, 1, cropMath.MAX_ZOOM);
    $("avatar-zoom").value = String(crop.zoom);
    renderCrop();
  };

  const openAvatarDialog = () => {
    setAvatarCropStatus("");
    $("avatar-dialog-file").value = "";
    releaseCropObjectUrl();
    resetCropUi();
    if (state.me?.avatar) setCropImage(state.me.avatar);
    $("avatar-dialog").showModal();
    document.body.classList.add("is-dialog-open");
  };

  const closeAvatarDialog = () => $("avatar-dialog").close();

  const saveAvatar = async (body) => {
    const { user } = await api("PUT", "api/cabinet/avatar", body);
    state.me = { ...state.me, ...user };
    renderAvatars();
  };

  $("avatar-dialog-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    releaseCropObjectUrl();
    cropObjectUrl = URL.createObjectURL(file);
    setAvatarCropStatus("");
    setCropImage(cropObjectUrl);
  });

  $("avatar-zoom").addEventListener("input", (event) => setCropZoom(event.target.value));

  const cropNode = $("avatar-crop");
  cropNode.addEventListener("pointerdown", (event) => {
    if (!crop.img) return;
    cropDrag = { x: event.clientX, y: event.clientY, cx: crop.cx, cy: crop.cy };
    cropNode.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  cropNode.addEventListener("pointermove", (event) => {
    if (!cropDrag || !crop.img) return;
    const side = cropMath.cropSide(crop.img.naturalWidth, crop.img.naturalHeight, crop.zoom);
    const scale = CROP_VIEW / side;
    crop.cx = cropDrag.cx - (event.clientX - cropDrag.x) / scale;
    crop.cy = cropDrag.cy - (event.clientY - cropDrag.y) / scale;
    renderCrop();
  });
  const endCropDrag = () => {
    cropDrag = null;
  };
  cropNode.addEventListener("pointerup", endCropDrag);
  cropNode.addEventListener("pointercancel", endCropDrag);
  cropNode.addEventListener(
    "wheel",
    (event) => {
      if (!crop.img) return;
      event.preventDefault();
      setCropZoom(crop.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );

  $("avatar-save").onclick = async () => {
    if (!crop.img) return;
    const { side, x, y } = cropMath.cropRect(
      crop.img.naturalWidth,
      crop.img.naturalHeight,
      crop.zoom,
      crop.cx,
      crop.cy,
    );
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    canvas.getContext("2d").drawImage(crop.img, x, y, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    setAvatarCropStatus("сохраняю…");
    try {
      await saveAvatar({ imageDataUrl: canvas.toDataURL("image/jpeg", 0.9) });
      $("avatar-status").textContent = "аватар обновлён ✓";
      closeAvatarDialog();
    } catch (error) {
      setAvatarCropStatus(error.message, true);
    }
  };

  const removeAvatar = async () => {
    try {
      await saveAvatar({ removeAvatar: true });
      $("avatar-status").textContent = "аватар убран";
      setAvatarCropStatus("аватар убран");
      if ($("avatar-dialog").open) closeAvatarDialog();
    } catch (error) {
      $("avatar-status").textContent = error.message;
      setAvatarCropStatus(error.message, true);
    }
  };
  $("btn-avatar-remove").onclick = removeAvatar;
  $("avatar-crop-remove").onclick = removeAvatar;

  $("btn-avatar-edit").onclick = openAvatarDialog;
  $("btn-avatar-change").onclick = openAvatarDialog;
  $("avatar-close").onclick = closeAvatarDialog;
  $("avatar-cancel").onclick = closeAvatarDialog;
  $("avatar-dialog").addEventListener("click", (event) => {
    if (event.target === $("avatar-dialog")) closeAvatarDialog();
  });
  $("avatar-dialog").addEventListener("close", () => {
    document.body.classList.remove("is-dialog-open");
    releaseCropObjectUrl();
    resetCropUi();
  });

  const refreshAll = async () => {
    const [summary, mine] = await Promise.all([
      api("GET", "api/public/summary"),
      api("GET", "api/cabinet/me"),
    ]);
    state.summary = summary;
    // мои оценки берём из /me: в summary их нет, если профиль скрыт
    state.mine = mine.ratings || [];
    state.addedSlugs = new Set((mine.addedDrinks || []).map((drink) => drink.slug));
    if (summary.site?.title) document.title = `${summary.site.title} — личный кабинет`;
    renderMine();
    renderUnrated();
    renderFind();
  };

  /* ---------- auth ---------- */
  const login = async () => {
    $("auth-status").textContent = "Проверяю…";
    try {
      const { user } = await api("POST", "api/auth/login", {
        username: $("auth-user").value.trim(),
        password: $("auth-pass").value,
      });
      state.me = user;
      $("auth-pass").value = "";
      $("auth-status").textContent = "";
      if (user.mustChangePassword) showPasswordChange();
      else await enterCabinet();
    } catch (error) {
      $("auth-status").textContent = error.message;
    }
  };

  $("btn-login").onclick = login;
  $("auth-user").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  $("auth-pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });

  $("btn-set-pass").onclick = async () => {
    const first = $("new-pass").value;
    const second = $("new-pass2").value;
    if (first !== second) {
      $("pass-status").textContent = "Пароли не совпадают";
      return;
    }
    try {
      await api("POST", "api/auth/password", { newPassword: first });
      state.me.mustChangePassword = false;
      $("new-pass").value = "";
      $("new-pass2").value = "";
      $("pass-status").textContent = "";
      await enterCabinet();
    } catch (error) {
      $("pass-status").textContent = error.message;
    }
  };

  $("btn-change-pass").onclick = async () => {
    try {
      await api("POST", "api/auth/password", {
        currentPassword: $("old-pass").value,
        newPassword: $("change-pass").value,
      });
      $("old-pass").value = "";
      $("change-pass").value = "";
      $("sync-status").textContent = "Пароль обновлён ✓";
    } catch (error) {
      $("sync-status").textContent = error.message;
    }
  };

  $("btn-logout").onclick = async () => {
    try {
      await api("POST", "api/auth/logout");
    } catch {
      /* всё равно перезагружаемся */
    }
    location.reload();
  };

  /* ---------- my ratings ---------- */
  const savingRatings = new Set();
  const saveRating = async (slug, tier, review) => {
    if (savingRatings.has(slug)) return;
    savingRatings.add(slug);
    const current = state.mine.find((item) => item.drink === slug) || {};
    try {
      await api("PUT", `api/cabinet/ratings/${encodeURIComponent(slug)}`, {
        tier: tier || current.tier || "B",
        review: review !== null && review !== undefined ? review : current.review || "",
      });
      await refreshAll();
    } catch (error) {
      alert(error.message);
    } finally {
      savingRatings.delete(slug);
    }
  };

  const renderMine = () => {
    const container = $("cabinet-my-ratings");
    // Перерисовка (фильтр, refresh после сохранения) не должна терять несохранённый
    // текст отзыва — переносим то, что уже набрано в DOM, обратно в состояние.
    container.querySelectorAll(".mine-row").forEach((row) => {
      const item = state.mine.find((rating) => rating.drink === row.dataset.drink);
      const review = row.querySelector("[data-m-review]")?.value;
      if (item && review !== undefined) item.review = review;
    });
    const all = state.mine;
    $("me-count").textContent = all.length;
    $("me-count-label").textContent = wordForm(all.length, ["оценка", "оценки", "оценок"]);
    if (!all.length) {
      container.innerHTML = `<p class="hint">Пока пусто — опиши первую банку выше или оцени чужую ниже.</p>`;
      return;
    }
    const needle = $("mine-filter").value.trim().toLowerCase();
    const mine = needle
      ? all.filter((item) => `${item.name} ${item.flavor}`.toLowerCase().includes(needle))
      : all;
    if (!mine.length) {
      container.innerHTML = `<p class="hint">Ничего не нашлось по «${esc(needle)}».</p>`;
      return;
    }
    container.innerHTML = mine
      .map((item) => {
        const drink = { id: item.drink, name: item.name, flavor: item.flavor, image: item.image };
        const rating = item;
        const own = state.addedSlugs.has(drink.id);
        return `
        <div class="mine-row" data-drink="${esc(drink.id)}">
          <img src="${esc(drink.image)}" alt="" loading="lazy">
          <div class="mine-row__main">
            <b>${esc(drink.name)}</b><small>${esc(drink.flavor)}</small>
            <textarea rows="2" data-m-review placeholder="Отзыв…">${esc(rating.review || "")}</textarea>
          </div>
          <div class="mine-row__actions">
            <select data-m-tier>${state.summary.tiers
              .map((tier) => `<option ${tier.id === rating.tier ? "selected" : ""}>${esc(tier.id)}</option>`)
              .join("")}</select>
            <button class="btn btn--ghost" type="button" data-m-edit>изменить</button>
            <button class="btn btn--danger" type="button" data-m-del-rating>удалить</button>
            ${own ? `<button class="btn btn--danger" type="button" data-m-del-drink>× банка</button>` : ""}
          </div>
        </div>`;
      })
      .join("");

    container.querySelectorAll(".mine-row").forEach((row) => {
      const slug = row.dataset.drink;
      row.querySelector("[data-m-tier]").onchange = (e) => saveRating(slug, e.target.value, null);
      row.querySelector("[data-m-review]").onchange = (e) => saveRating(slug, null, e.target.value);
      const rating = state.mine.find((item) => item.drink === slug) || {};
      const drink = state.summary.drinks.find((item) => item.id === slug) || { name: rating.name };
      row.querySelector("[data-m-edit]").onclick = () => openOpinion(slug);
      row.querySelector("[data-m-del-rating]").onclick = async () => {
        const ok = await window.nrgConfirm({
          title: "Удалить оценку?",
          message: `Твоя оценка для «${drink?.name || slug}» пропадёт из индекса.`,
          details: [
            `Тир: ${rating.tier || "—"}`,
            rating.review ? `Отзыв: «${String(rating.review).slice(0, 140)}»` : "",
          ],
          confirmText: "Удалить оценку",
        });
        if (!ok) return;
        try {
          await api("DELETE", `api/cabinet/ratings/${encodeURIComponent(slug)}`);
          await refreshAll();
        } catch (error) {
          alert(error.message);
        }
      };
      row.querySelector("[data-m-del-drink]")?.addEventListener("click", async () => {
        const votes = Object.keys(drink?.ratings || {}).length;
        const ok = await window.nrgConfirm({
          title: "Удалить банку?",
          message: `«${drink?.name || slug}» исчезнет из индекса целиком.`,
          details: [votes ? `Вместе с ней удалятся все оценки: ${votes}` : ""],
          confirmText: "Удалить банку",
        });
        if (!ok) return;
        try {
          await api("DELETE", `api/cabinet/drinks/${encodeURIComponent(slug)}`);
          await refreshAll();
        } catch (error) {
          alert(error.message);
        }
      });
    });
  };

  $("mine-filter").addEventListener("input", () => renderMine());

  /* ---------- редактор своего мнения ---------- */
  // Своё мнение целиком: тир и отзыв плюс полное управление фото банки
  // (заменить своим файлом, найти в интернете, убрать). Всё с историей правок.
  const opinion = { slug: "", image: null, remove: false, original: null, originalUrl: null, drink: null, fromSmart: false };

  const setOpStatus = (text, isError = false) => {
    $("op-status").textContent = text;
    $("op-status").style.color = isError ? "#ff8a8a" : "";
  };

  const setOpPhotoStatus = (text, isError = false) => {
    $("op-photo-status").textContent = text;
    $("op-photo-status").style.color = isError ? "#ff8a8a" : "";
  };

  const resetOpinionPhotos = () => {
    $("op-photo-strip").hidden = true;
    $("op-photo-track").innerHTML = "";
    $("op-strip-status").textContent = "";
    setOpPhotoStatus("");
  };

  const pickOpinionImage = (dataUrl, note) => {
    opinion.image = dataUrl;
    opinion.remove = false;
    $("op-image").src = dataUrl;
    $("op-image").hidden = false;
    setOpPhotoStatus(note);
  };

  const closeOpinion = () => {
    $("opinion-editor").close();
    document.body.classList.remove("is-dialog-open");
  };

  // Открывается и из «Моих оценок», и из «Ещё не оценил», и из похожих в смарт-форме.
  // options: { tier, review, aiText, fromSmart } — предзаполнение (например, разбором ИИ).
  const openOpinion = (slug, options = {}) => {
    const mine = state.mine.find((row) => row.drink === slug) || null;
    const drink = state.summary.drinks.find((row) => row.id === slug) || mine;
    if (!drink) return;
    opinion.slug = slug;
    opinion.image = null;
    opinion.remove = false;
    opinion.original = null;
    opinion.originalUrl = null;
    opinion.fromSmart = Boolean(options.fromSmart);
    // Контекст банки для ИИ: без названия разбор отметки не знает, о чём речь.
    opinion.drink = { brand: drink.brand || "", name: drink.name || "", flavor: drink.flavor || "" };
    $("op-title").textContent = drink.name;
    $("op-sub").textContent = drink.flavor || "без вкуса";
    $("op-image").src = mine?.image || drink.image || "assets/favicon.svg";
    $("op-image").hidden = false;
    const currentTier = options.tier || mine?.tier || "B";
    $("op-tier").innerHTML = state.summary.tiers
      .map((tier) => `<option ${tier.id === currentTier ? "selected" : ""}>${esc(tier.id)}</option>`)
      .join("");
    $("op-review").value = options.review !== undefined ? options.review : mine?.review || "";
    $("op-ai-text").value = options.aiText || "";
    $("op-photo-file").value = "";
    $("op-photo-query").value = [drink.name, drink.flavor].filter(Boolean).join(" ");
    $("op-photo-panel").hidden = true;
    resetOpinionPhotos();
    setOpStatus(options.fromSmart ? "ИИ уже разобрал твоё сообщение — проверь и сохрани" : "");
    clearVoice("opinion");
    $("opinion-editor").showModal();
    document.body.classList.add("is-dialog-open");
    autoGrow($("op-ai-text"), 160);
    updateOpButton();
    autoGrow($("op-review"));
  };

  $("op-close").onclick = closeOpinion;
  $("op-cancel").onclick = closeOpinion;
  $("opinion-editor").addEventListener("close", () => document.body.classList.remove("is-dialog-open"));

  // Все действия с фото спрятаны за кликом по самому фото — в диалоге нет
  // свалки из кнопок, а варианты открываются, когда они реально нужны.
  $("op-photo-open").onclick = () => {
    const panel = $("op-photo-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden && !opinion.image && !opinion.remove) {
      setOpPhotoStatus("выбери способ: свой файл, поиск в интернете или перерисовка 🍌");
    }
  };

  const updateOpButton = () => {
    $("op-ai-parse").disabled = !$("op-ai-text").value.trim();
  };
  $("op-ai-text").addEventListener("input", updateOpButton);

  // ИИ в редакторе отметки: свободный текст → тир и отзыв, всё остаётся правимым.
  const parseOpinionText = async () => {
    const text = $("op-ai-text").value.trim();
    if (text.replace(/\s+/g, "").length < 2) {
      setOpStatus("напиши хоть пару слов или надиктуй голосом", true);
      return;
    }
    $("op-ai-parse").disabled = true;
    setOpStatus("✦ Обрабатываю текст…");
    try {
      const { parsed } = await api("POST", "api/cabinet/ai/parse", { text, drink: opinion.drink });
      if (TIERS.includes(parsed.tier)) $("op-tier").value = parsed.tier;
      if (parsed.review) {
        $("op-review").value = parsed.review;
        autoGrow($("op-review"));
      }
      setOpStatus(
        parsed.tierGuessed ? "разобрано ✓ тир не был назван — проверь и поправь" : "разобрано ✓ проверь и сохрани",
      );
    } catch (error) {
      setOpStatus(error.message, true);
    } finally {
      updateOpButton();
    }
  };
  $("op-ai-parse").onclick = parseOpinionText;
  $("op-ai-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      parseOpinionText();
    }
  });
  $("op-ai-text").addEventListener("input", () => autoGrow($("op-ai-text"), 160));
  $("op-review").addEventListener("input", () => autoGrow($("op-review")));

  $("op-photo-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    try {
      setOpPhotoStatus("📷 Обрабатываю фото…");
      const img = await loadImage(objectUrl);
      opinion.original = shrinkOnly(img);
      opinion.originalUrl = null;
      const { dataUrl, cut } = prepareImage(img);
      pickOpinionImage(dataUrl, cut ? "твоё фото · фон вырезан ✓" : "твоё фото · фон не вырезан");
    } catch {
      setOpPhotoStatus("не удалось прочитать файл", true);
    } finally {
      URL.revokeObjectURL(objectUrl);
      event.target.value = "";
    }
  });

  const searchOpinionPhotos = async () => {
    const query = $("op-photo-query").value.trim();
    if (query.replace(/\s+/g, "").length < 2) {
      setOpPhotoStatus("введи хотя бы 2 символа", true);
      return;
    }
    try {
      setOpPhotoStatus("Ищу фото…");
      $("op-photo-strip").hidden = false;
      $("op-photo-track").innerHTML = "";
      const params = new URLSearchParams({ q: query });
      const { images } = await api("GET", `api/cabinet/ai/photo-search?${params}`);
      if (!images?.length) {
        setOpPhotoStatus("ничего не нашлось — уточни запрос", true);
        return;
      }
      setOpPhotoStatus(`${images.length} шт · жми нужное`);
      images.forEach((item) => {
        const tile = document.createElement("button");
        tile.type = "button";
        tile.className = "photo-tile";
        tile.title = item.title || "";
        const img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.referrerPolicy = "no-referrer";
        bindTileImage(img, tile, item.url);
        tile.appendChild(img);
        tile.onclick = async () => {
          try {
            tile.classList.add("is-loading");
            const dataUrl = await processImageUrl(item.url);
            $("op-photo-track")
              .querySelectorAll(".photo-tile")
              .forEach((node) => node.classList.remove("is-selected"));
            tile.classList.remove("is-loading");
            tile.classList.add("is-selected");
            opinion.original = null;
            opinion.originalUrl = item.url;
            pickOpinionImage(dataUrl, "фото из ленты ✓");
          } catch {
            tile.classList.remove("is-loading");
            setOpPhotoStatus("не удалось взять это фото", true);
          }
        };
        $("op-photo-track").appendChild(tile);
      });
    } catch (error) {
      setOpPhotoStatus(error.message, true);
    }
  };

  $("op-photo-find").onclick = () => {
    $("op-photo-strip").hidden = false;
    $("op-photo-query").focus();
  };
  $("op-photo-search").onclick = searchOpinionPhotos;
  $("op-photo-query").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchOpinionPhotos();
    }
  });
  $("op-photo-remove").onclick = () => {
    opinion.image = null;
    opinion.remove = true;
    opinion.original = null;
    opinion.originalUrl = null;
    $("op-image").src = "assets/favicon.svg";
    setOpPhotoStatus("фото будет убрано при сохранении");
  };

  $("op-photo-redraw").onclick = () =>
    redrawCurrentPhoto({
      get: async () => {
        if (opinion.originalUrl) return originalDataUrl(opinion.originalUrl);
        return opinion.original;
      },
      set: ({ dataUrl, cut, note }) =>
        pickOpinionImage(dataUrl, note || (cut ? "перерисовано 🍌 · фон снят ✓" : "перерисовано 🍌 · фон снять не вышло")),
      button: $("op-photo-redraw"),
      say: setOpPhotoStatus,
    });

  let savingOpinion = false;
  $("op-save").onclick = async () => {
    const slug = opinion.slug;
    if (!slug || savingOpinion) return;
    savingOpinion = true;
    try {
      setOpStatus("сохраняю…");
      await api("PUT", `api/cabinet/ratings/${encodeURIComponent(slug)}`, {
        tier: $("op-tier").value,
        review: $("op-review").value,
      });
      if (opinion.image) {
        await api("PUT", `api/cabinet/drinks/${encodeURIComponent(slug)}/photo`, {
          imageDataUrl: opinion.image,
        });
      } else if (opinion.remove) {
        await api("PUT", `api/cabinet/drinks/${encodeURIComponent(slug)}/photo`, { removeImage: true });
      }
      closeOpinion();
      if (opinion.fromSmart) {
        resetSmart();
        $("smart-status").textContent = "Оценка сохранена ✓";
      }
      await refreshAll();
    } catch (error) {
      setOpStatus(error.message, true);
    } finally {
      savingOpinion = false;
    }
  };

  /* ---------- unrated ---------- */
  // Банки, которые завели другие, а я ещё не оценил. Тир — одним кликом.
  const UNRATED_PAGE = 12;
  let unratedShown = UNRATED_PAGE;

  const renderUnrated = () => {
    const rated = new Set(state.mine.map((item) => item.drink));
    const list = state.summary.drinks.filter((drink) => !rated.has(drink.id)).reverse();
    $("unrated-block").hidden = !list.length;
    if (!list.length) return;
    $("unrated-count").textContent = `${list.length} ${wordForm(list.length, ["банка", "банки", "банок"])}`;
    const tiers = state.summary.tiers.map((tier) => tier.id);
    $("unrated-list").innerHTML = list
      .slice(0, unratedShown)
      .map(
        (drink) => `
        <div class="unrated-card" data-drink="${esc(drink.id)}">
          <img src="${esc(drink.image)}" alt="" loading="lazy">
          <b>${esc(drink.name)}</b>
          <small>${esc(drink.flavor)}</small>
          <div class="unrated-card__tiers" role="group" aria-label="Тир для ${esc(drink.name)}">
            ${tiers.map((tier) => `<button type="button" data-tier="${esc(tier)}" style="--tier-color:${TIER_COLORS[tier] || "#ff4f79"}">${esc(tier)}</button>`).join("")}
          </div>
        </div>`,
      )
      .join("");
    $("unrated-more").hidden = list.length <= unratedShown;
  };

  // Тир не улетает в индекс сразу: открываем редактор с выбранным тиром,
  // чтобы можно было дописать отзыв (или надиктовать ИИ) и проверить всё до публикации.
  $("unrated-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tier]");
    if (!button) return;
    const card = button.closest(".unrated-card");
    openOpinion(card.dataset.drink, { tier: button.dataset.tier });
  });
  $("unrated-more").onclick = () => {
    unratedShown += UNRATED_PAGE;
    renderUnrated();
  };

  /* ---------- search existing ---------- */
  // Ту же банку не обязательно заводить заново: ищем по уже загруженному summary
  // и открываем редактор мнения с выбранным тиром — как в «Ещё не оценил».
  const FIND_PAGE = 18;

  const renderFind = () => {
    const needle = $("find-input").value.trim().toLowerCase();
    const container = $("find-results");
    if (!needle) {
      container.innerHTML = "";
      $("find-count").textContent = "";
      return;
    }
    const words = needle.split(/\s+/).filter(Boolean);
    const list = state.summary.drinks.filter((drink) =>
      words.every((word) =>
        [drink.brand, drink.name, drink.flavor, drink.edition]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(word),
      ),
    );
    const shown = list.slice(0, FIND_PAGE);
    $("find-count").textContent =
      list.length > shown.length
        ? `${shown.length} из ${list.length} — уточни запрос`
        : `${list.length} ${wordForm(list.length, ["банка", "банки", "банок"])}`;
    if (!list.length) {
      container.innerHTML = `<p class="hint">Ничего не нашлось — такую банку можно добавить формой выше.</p>`;
      return;
    }
    const tiers = state.summary.tiers.map((tier) => tier.id);
    container.innerHTML = shown
      .map((drink) => {
        const mine = state.mine.find((item) => item.drink === drink.id);
        return `
        <div class="unrated-card" data-drink="${esc(drink.id)}">
          <img src="${esc(drink.image)}" alt="" loading="lazy">
          <b>${esc(drink.name)}</b>
          <small>${esc(drink.flavor)}${mine ? ` · у тебя ${esc(mine.tier)}` : ""}</small>
          <div class="unrated-card__tiers" role="group" aria-label="Тир для ${esc(drink.name)}">
            ${tiers.map((tier) => `<button type="button" data-tier="${esc(tier)}" style="--tier-color:${TIER_COLORS[tier] || "#ff4f79"}">${esc(tier)}</button>`).join("")}
          </div>
        </div>`;
      })
      .join("");
  };

  $("find-input").addEventListener("input", renderFind);
  $("find-results").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tier]");
    if (!button) return;
    openOpinion(button.closest(".unrated-card").dataset.drink, { tier: button.dataset.tier });
  });

  /* ---------- images ---------- */
  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });

  // Сайты часто режут хотлинк и не отдают CORS — тогда грузим через наш прокси:
  // он same-origin, canvas после него чистый.
  const proxiedPhotoUrl = (url) => `api/cabinet/ai/photo-proxy?url=${encodeURIComponent(url)}`;

  const loadImageWithFallback = async (src) => {
    try {
      return await loadImage(src);
    } catch (error) {
      if (/^(blob:|data:|api\/cabinet\/ai\/photo-proxy)/.test(src)) throw error;
      return await loadImage(proxiedPhotoUrl(src));
    }
  };

  // <img> в лентах: сначала напрямую (не жрём трафик сервера),
  // при ошибке — один раз через прокси, потом убираем плитку.
  const bindTileImage = (img, tile, url) => {
    img.src = url;
    img.onerror = () => {
      if (img.dataset.proxied) {
        tile.remove();
        return;
      }
      img.dataset.proxied = "1";
      img.src = proxiedPhotoUrl(url);
    };
  };

  // Стоковое фото = края картинки прозрачные или ровно белые/светло-серые.
  // Поисковики такого фильтра не дают, поэтому меряем сами по пикселям рамки.
  const STOCK_MIN = 0.8;
  const borderStats = (px, w, h) => {
    const border = [];
    for (let x = 0; x < w; x += 2) border.push(x * 4, ((h - 1) * w + x) * 4);
    for (let y = 0; y < h; y += 2) border.push(y * w * 4, (y * w + w - 1) * 4);
    let clear = 0;
    let white = 0;
    for (const offset of border) {
      if (px[offset + 3] < 16) clear++;
      else if (
        Math.min(px[offset], px[offset + 1], px[offset + 2]) > 225 &&
        Math.max(px[offset], px[offset + 1], px[offset + 2]) - Math.min(px[offset], px[offset + 1], px[offset + 2]) < 18
      ) {
        white++;
      }
    }
    const n = border.length || 1;
    return { border, transparent: clear / n, white: white / n, stock: (clear + white) / n };
  };

  const drawScaled = (img, maxSide) => {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas, ctx, w, h };
  };

  /**
   * Готовит фото: прозрачный PNG берём как есть, иначе режем белый фон заливкой от краёв.
   * Возвращает { dataUrl, cut, stock } — stock (0..1) = доля «стоковой» рамки.
   */
  const prepareImage = (img, maxSide = 640) => {
    const { canvas, ctx, w, h } = drawScaled(img, maxSide);
    const stats = borderStats(ctx.getImageData(0, 0, w, h).data, w, h);
    if (stats.transparent > 0.6) {
      // фон уже прозрачный: заливка по «цвету» прозрачных пикселей (обычно чёрному) съела бы банку
      return { dataUrl: canvas.toDataURL("image/png"), cut: true, stock: stats.stock };
    }
    const cut = cutWhiteBg(img, maxSide);
    return { dataUrl: cut || shrinkOnly(img, maxSide), cut: Boolean(cut), stock: stats.stock };
  };

  const cutWhiteBg = (img, maxSide = 640) => {
    const { canvas, ctx, w, h } = drawScaled(img, maxSide);
    const imageData = ctx.getImageData(0, 0, w, h);
    const px = imageData.data;

    const { border } = borderStats(px, w, h);
    const channels = [[], [], []];
    for (const offset of border) {
      if (px[offset + 3] < 16) continue;
      channels[0].push(px[offset]);
      channels[1].push(px[offset + 1]);
      channels[2].push(px[offset + 2]);
    }
    if (!channels[0].length) return null;
    const median = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const bg = [median(channels[0]), median(channels[1]), median(channels[2])];

    const TOL = 44;
    const BRIGHT_MIN = 120;
    const NEUTRAL_MAX = 34;
    const isBgish = (offset) => {
      if (px[offset + 3] < 16) return true;
      const r = px[offset];
      const g = px[offset + 1];
      const b = px[offset + 2];
      if (Math.hypot(r - bg[0], g - bg[1], b - bg[2]) < TOL) return true;
      return (
        Math.min(r, g, b) > BRIGHT_MIN && Math.max(r, g, b) - Math.min(r, g, b) < NEUTRAL_MAX
      );
    };

    // Контур банки — стена для заливки: перепад яркости останавливает рез,
    // даже если цвет похож на фон. Работает на фоне любого цвета.
    const EDGE_T = 48;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      lum[i] = (px[o] * 299 + px[o + 1] * 587 + px[o + 2] * 114) / 1000;
    }
    const isEdge = (x, y) => {
      if (x <= 0 || x >= w - 1 || y <= 0 || y >= h - 1) return false;
      const gx = Math.abs(lum[y * w + x + 1] - lum[y * w + x - 1]);
      const gy = Math.abs(lum[(y + 1) * w + x] - lum[(y - 1) * w + x]);
      return gx + gy > EDGE_T;
    };
    const canFill = (x, y) => !isEdge(x, y) && isBgish((y * w + x) * 4);

    const mask = new Uint8Array(w * h);
    const stack = [];
    const seed = (x, y) => {
      const i = y * w + x;
      if (!mask[i] && canFill(x, y)) {
        mask[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < w; x++) {
      seed(x, 0);
      seed(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      seed(0, y);
      seed(w - 1, y);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && !mask[i - 1] && canFill(x - 1, y)) {
        mask[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x < w - 1 && !mask[i + 1] && canFill(x + 1, y)) {
        mask[i + 1] = 1;
        stack.push(i + 1);
      }
      if (y > 0 && !mask[i - w] && canFill(x, y - 1)) {
        mask[i - w] = 1;
        stack.push(i - w);
      }
      if (y < h - 1 && !mask[i + w] && canFill(x, y + 1)) {
        mask[i + w] = 1;
        stack.push(i + w);
      }
    }

    let bgShare = 0;
    for (let i = 0; i < mask.length; i++) bgShare += mask[i];
    bgShare /= mask.length;
    if (bgShare < 0.005) return null;

    const grown = Uint8Array.from(mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) continue;
        if (
          (x > 0 && mask[y * w + x - 1]) ||
          (x < w - 1 && mask[y * w + x + 1]) ||
          (y > 0 && mask[(y - 1) * w + x]) ||
          (y < h - 1 && mask[(y + 1) * w + x])
        ) {
          grown[y * w + x] = 1;
        }
      }
    }
    for (let i = 0; i < grown.length; i++) if (grown[i]) px[i * 4 + 3] = 0;
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  };

  /**
   * Снимает зелёный хромакей (фон от Nano Banana) заливкой от краёв — как cutWhiteBg,
   * только предикат «зелёности». Заливка от краёв обязательна: зелёные элементы
   * этикетки внутри банки трогать нельзя. null — рамка не зелёная, не хромакей.
   */
  const cutGreenBg = (img, maxSide = 640) => {
    const { canvas, ctx, w, h } = drawScaled(img, maxSide);
    const imageData = ctx.getImageData(0, 0, w, h);
    const px = imageData.data;

    const isGreen = (r, g, b) => g > 100 && g - Math.max(r, b) > 60;
    const { border } = borderStats(px, w, h);
    const greens = [];
    for (const offset of border) {
      if (px[offset + 3] < 16) continue;
      const r = px[offset];
      const g = px[offset + 1];
      const b = px[offset + 2];
      if (isGreen(r, g, b)) greens.push([r, g, b]);
    }
    if (greens.length < border.length * 0.5) return null;

    // Ослаблено: режем только насыщенный зелёный хромакей. Зеленовато-белые части
    // банки (белая этикетка/блики с зелёным рефлексом) и слабые блики остаются.
    const isBgish = (offset) => {
      if (px[offset + 3] < 16) return true;
      return isGreen(px[offset], px[offset + 1], px[offset + 2]);
    };

    // Контур банки — стена для заливки, как в cutWhiteBg: графика этикетки не страдает.
    const EDGE_T = 48;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      lum[i] = (px[o] * 299 + px[o + 1] * 587 + px[o + 2] * 114) / 1000;
    }
    const isEdge = (x, y) => {
      if (x <= 0 || x >= w - 1 || y <= 0 || y >= h - 1) return false;
      const gx = Math.abs(lum[y * w + x + 1] - lum[y * w + x - 1]);
      const gy = Math.abs(lum[(y + 1) * w + x] - lum[(y - 1) * w + x]);
      return gx + gy > EDGE_T;
    };
    const canFill = (x, y) => !isEdge(x, y) && isBgish((y * w + x) * 4);

    const mask = new Uint8Array(w * h);
    const stack = [];
    const seed = (x, y) => {
      const i = y * w + x;
      if (!mask[i] && canFill(x, y)) {
        mask[i] = 1;
        stack.push(i);
      }
    };
    for (let x = 0; x < w; x++) {
      seed(x, 0);
      seed(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      seed(0, y);
      seed(w - 1, y);
    }
    while (stack.length) {
      const i = stack.pop();
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && !mask[i - 1] && canFill(x - 1, y)) {
        mask[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x < w - 1 && !mask[i + 1] && canFill(x + 1, y)) {
        mask[i + 1] = 1;
        stack.push(i + 1);
      }
      if (y > 0 && !mask[i - w] && canFill(x, y - 1)) {
        mask[i - w] = 1;
        stack.push(i - w);
      }
      if (y < h - 1 && !mask[i + w] && canFill(x, y + 1)) {
        mask[i + w] = 1;
        stack.push(i + w);
      }
    }

    let bgShare = 0;
    for (let i = 0; i < mask.length; i++) bgShare += mask[i];
    bgShare /= mask.length;
    if (bgShare < 0.005) return null;

    const grown = Uint8Array.from(mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) continue;
        if (
          (x > 0 && mask[y * w + x - 1]) ||
          (x < w - 1 && mask[y * w + x + 1]) ||
          (y > 0 && mask[(y - 1) * w + x]) ||
          (y < h - 1 && mask[(y + 1) * w + x])
        ) {
          grown[y * w + x] = 1;
        }
      }
    }
    for (let i = 0; i < grown.length; i++) if (grown[i]) px[i * 4 + 3] = 0;
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  };

  const shrinkOnly = (img, maxSide = 640) => {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  };

  // PNG-версия ужатия: альфу не теряем — результат OpenRouter уже вырезан.
  const shrinkPng = (img, maxSide = 640) => {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  };

  const processImageUrl = async (url) => prepareImage(await loadImageWithFallback(url)).dataUrl;

  // Необработанный оригинал по ссылке: только ужатие, без резки фона.
  // Нужен перерисовке — резаная картинка с кривым фоном путает модель.
  const originalDataUrl = async (url) => shrinkOnly(await loadImageWithFallback(url));

  // Финиш перерисовки: снимаем зелёный хромакей от Nano Banana (заливкой от краёв,
  // зелень этикетки не трогаем). Нет зелени — пробуем белый фон, иначе как есть.
  const finishRedrawn = async (dataUrl) => {
    const img = await loadImage(dataUrl);
    const green = cutGreenBg(img);
    if (green) return { dataUrl: green, cut: true };
    const white = cutWhiteBg(img);
    return { dataUrl: white || shrinkOnly(img), cut: Boolean(white) };
  };

  // Перерисовка через Nano Banana: НЕОБРАБОТАННЫЙ оригинал → прямой ракурс,
  // зелёный хромакей → снимаем его тем же заливным алгоритмом, что режет фон.
  // get/set/статус инжектятся, потому что превьюшек две: смарт-форма и редактор мнения.
  const redrawCurrentPhoto = async ({ get, set, button, say }) => {
    button.disabled = true;
    try {
      say("🍌 беру оригинал…");
      const current = await get();
      if (!current || !current.startsWith("data:")) {
        say("сначала выбери или приложи фото", true);
        return;
      }
      say("🍌 перерисовываю банку…");
      const { imageDataUrl, provider } = await api("POST", "api/cabinet/ai/photo-redraw", { imageDataUrl: current });
      if (provider === "openrouter") {
        // OpenRouter рисует сразу на прозрачном фоне — резать нечего.
        set({ dataUrl: shrinkPng(await loadImage(imageDataUrl)), note: "перерисовано 🍌 · прозрачный фон ✓" });
        return;
      }
      say("🍌 снимаю зелёный фон…");
      set(await finishRedrawn(imageDataUrl));
    } catch (error) {
      say(error.message, true);
    } finally {
      button.disabled = false;
    }
  };

  /* ---------- рулетка по ассортименту ---------- */
  const assortment = { items: [], drum: null, spinning: false, winner: null };

  // Средний тир известной банки — из публичной сводки, как на главной.
  const assortmentTier = (slug) => {
    const drink = state.summary?.drinks.find((row) => row.id === slug);
    const scores = Object.values(drink?.ratings || {})
      .map((rating) => state.summary.tiers.find((tier) => tier.id === rating.tier)?.score)
      .filter(Boolean);
    if (!scores.length) return null;
    const value = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    return state.summary.tiers.find((tier) => tier.score === Math.round(value)) || null;
  };

  const assortmentItem = (item) => {
    if (item.slug) {
      const drink = state.summary?.drinks.find((row) => row.id === item.slug);
      const tier = assortmentTier(item.slug);
      return `<span class="roulette__item" style="--card-accent:${safeColor(drink?.accent?.[0], "#ff4f79")}">
        ${tier ? `<b style="color:${TIER_COLORS[tier.id] || "#ff4f79"}">${esc(tier.id)}</b>` : ""}
        <img src="${esc(item.image || "assets/favicon.svg")}" alt="" loading="lazy" decoding="async">
        <small>${esc(item.name)}</small>
      </span>`;
    }
    return `<span class="roulette__item roulette__item--text" style="--card-accent:#ff4f79">
      <strong>${esc(item.name)}</strong><em>${esc(item.flavor || "вкус не распознан")}</em>
    </span>`;
  };

  assortment.drum = window.NrgRoulette.create($("assortment-reel"), assortmentItem);

  $("assortment-photo").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const status = $("assortment-status");
    try {
      status.textContent = "смотрю фото…";
      const objectUrl = URL.createObjectURL(file);
      let dataUrl;
      try {
        dataUrl = shrinkOnly(await loadImage(objectUrl), 1280);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      const { items } = await api("POST", "api/cabinet/ai/assortment", { imageDataUrl: dataUrl });
      if (!items?.length) {
        status.textContent = "не разглядел ни одной банки — попробуй ближе и без бликов";
        return;
      }
      assortment.items = items;
      assortment.winner = null;
      $("assortment-window").hidden = false;
      $("assortment-bottom").hidden = false;
      $("assortment-clear").hidden = false;
      $("assortment-result").textContent = "";
      $("assortment-count").textContent = `распознано: ${items.length}`;
      assortment.drum.reset(items);
      status.textContent = "готово — жми «Крутить»";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      event.target.value = "";
    }
  });

  $("assortment-spin").onclick = async () => {
    if (assortment.spinning || !assortment.items.length) return;
    assortment.spinning = true;
    $("assortment-spin").disabled = true;
    $("assortment-result").textContent = "крутим…";
    const winner = await assortment.drum.spin({
      pool: assortment.items,
      onWinner: (item) => {
        assortment.winner = item;
        $("assortment-result").innerHTML = item.slug
          ? `сегодня: <button type="button" class="roulette__open" data-assortment-open="${esc(item.slug)}">${esc(item.name)}${item.flavor ? ` — ${esc(item.flavor)}` : ""} →</button>`
          : `сегодня: <b>${esc(item.name)}</b>${item.flavor ? ` — ${esc(item.flavor)}` : ""} <button type="button" class="btn btn--ghost" data-assortment-add>Завести в индекс</button>`;
      },
    });
    if (winner) $("assortment-spin").textContent = "Ещё раз";
    assortment.spinning = false;
    $("assortment-spin").disabled = false;
  };

  $("assortment-result").addEventListener("click", (event) => {
    const slug = event.target.closest("[data-assortment-open]")?.dataset.assortmentOpen;
    if (slug) {
      openOpinion(slug);
      return;
    }
    if (!event.target.closest("[data-assortment-add]")) return;
    const item = assortment.winner;
    if (!item) return;
    // Незнакомую банку предзаполняем в смарт-форму — проверить и сохранить.
    pending.parsed = {
      brand: item.brand,
      name: item.name,
      flavor: item.flavor,
      edition: "",
      tier: "B",
      tierGuessed: true,
      review: "",
    };
    switchCabTab("add");
    showPreview();
    refreshPhotos();
    $("smart-status").textContent = "Проверь поля и жми «В индекс ✓»";
  });

  $("assortment-clear").onclick = () => {
    assortment.items = [];
    assortment.winner = null;
    assortment.drum.reset([]);
    $("assortment-window").hidden = true;
    $("assortment-bottom").hidden = true;
    $("assortment-clear").hidden = true;
    $("assortment-result").textContent = "";
    $("assortment-count").textContent = "";
    $("assortment-status").textContent = "";
  };

  /* ---------- smart flow ---------- */
  const TIERS = ["S", "A", "B", "C", "D"];

  const updateTierNote = () => {
    $("parsed-tier-note").textContent = pending.parsed?.tierGuessed
      ? "тир не был назван — стоит B по умолчанию, поправь"
      : "";
  };

  const applyParsedToPreview = (parsed) => {
    $("parsed-brand").value = parsed.brand || "";
    $("parsed-name").value = parsed.name || "";
    $("parsed-flavor").value = parsed.flavor || "";
    $("parsed-edition").value = parsed.edition || "";
    $("parsed-tier").innerHTML = state.summary.tiers
      .map((tier) => `<option ${tier.id === parsed.tier ? "selected" : ""}>${esc(tier.id)}</option>`)
      .join("");
    $("parsed-review").value = parsed.review || "";
    updateTierNote();
  };

  const readPreviewFields = () => ({
    brand: $("parsed-brand").value.trim(),
    name: $("parsed-name").value.trim(),
    flavor: $("parsed-flavor").value.trim(),
    edition: $("parsed-edition").value.trim(),
    tier: $("parsed-tier").value,
    review: $("parsed-review").value.trim(),
  });

  const showPreview = () => {
    const parsed = pending.parsed;
    if (!parsed) return;
    $("smart-preview").hidden = false;
    applyParsedToPreview(parsed);
    updatePreviewImage();
    $("smart-preview").scrollIntoView({ behavior: "smooth", block: "start" });
  };

  /* ---------- photo strip ---------- */
  // Лента найденных фото: ищет по бренду + названию + вкусу, каждое фото сразу
  // прогоняется через cutWhiteBg, выбор — кликом. Перезапрашивается при правке полей.
  // photoSource: "auto" — выбрано лентой само, "strip" — кликом, "user"/"url" — своё.
  const strip = { gen: 0, key: "", items: [], selected: -1, timer: null };
  const STRIP_CONCURRENCY = 4;
  const STRIP_DEBOUNCE_MS = 700;

  const photoQuery = () => ({
    brand: $("parsed-brand").value.trim(),
    name: $("parsed-name").value.trim(),
    flavor: $("parsed-flavor").value.trim(),
  });

  const updatePreviewImage = () => {
    const img = $("parsed-img");
    if (pending.image) {
      img.src = pending.image;
      img.hidden = false;
    } else {
      img.removeAttribute("src");
      img.hidden = true;
    }
    $("parsed-photo-note").textContent = pending.photoNote || "";
  };

  const setStripStatus = (text) => {
    $("photo-strip-status").textContent = text;
  };

  const markSelected = () => {
    $("photo-track")
      .querySelectorAll(".photo-tile")
      .forEach((tile) => {
        const on = Number(tile.dataset.index) === strip.selected;
        tile.classList.toggle("is-selected", on);
        tile.setAttribute("aria-selected", on ? "true" : "false");
      });
  };

  const selectTile = (index, source) => {
    const item = strip.items[index];
    if (!item?.dataUrl) return;
    strip.selected = index;
    pending.image = item.dataUrl;
    pending.photoSource = source;
    pending.userPhoto = false;
    pending.photoNote =
      (source === "auto" ? "фото найдено автоматически ✓" : "фото выбрано из ленты ✓") +
      (item.isStock ? " · стоковое" : item.cut ? "" : " · фон не вырезан");
    markSelected();
    updatePreviewImage();
  };

  const renderTile = (index) => {
    const item = strip.items[index];
    let tile = $("photo-track").querySelector(`[data-index="${index}"]`);
    if (item.state === "failed") {
      tile?.remove();
      return;
    }
    if (!tile && item.state === "ready") {
      tile = document.createElement("button");
      tile.className = "photo-tile";
      tile.type = "button";
      tile.setAttribute("role", "option");
      tile.setAttribute("aria-selected", "false");
      tile.dataset.index = String(index);
      tile.title = item.title;
      $("photo-track").appendChild(tile);
    }
    if (!tile) return;
    tile.classList.toggle("is-loading", item.state === "loading");
    if (item.state !== "ready") return;
    const badge = item.isStock
      ? `<span class="photo-tile__badge photo-tile__badge--stock">сток</span>`
      : item.cut
        ? ""
        : `<span class="photo-tile__badge">фон</span>`;
    tile.innerHTML = `<img src="${item.dataUrl}" alt="">${badge}`;
    tile.classList.toggle("is-stock", item.isStock);
    tile.disabled = false;
    applyStockFilter();
  };

  const readyCount = () => strip.items.filter((item) => item.state === "ready").length;
  const stockCount = () => strip.items.filter((item) => item.state === "ready" && item.isStock).length;

  // «только сток»: прячем фото из жизни, но если стоковых нет вовсе — показываем всё
  const applyStockFilter = () => {
    const only = $("photo-stock-only").checked && stockCount() > 0;
    $("photo-track").classList.toggle("is-stock-only", only);
  };

  // стоковые — в начало ленты (порядок внутри групп сохраняем)
  const sortTiles = () => {
    const track = $("photo-track");
    const tiles = [...track.querySelectorAll(".photo-tile")];
    const rank = (tile) => (strip.items[Number(tile.dataset.index)]?.isStock ? 0 : 1);
    tiles
      .map((tile, order) => ({ tile, order }))
      .sort((a, b) => rank(a.tile) - rank(b.tile) || a.order - b.order)
      .forEach(({ tile }) => track.appendChild(tile));
    track.scrollLeft = 0;
  };

  const finishStrip = () => {
    const ready = readyCount();
    if (!ready) {
      setStripStatus("ничего подходящего — приложи своё фото или ссылку");
      if (pending.photoSource === "auto") {
        pending.image = null;
        pending.original = null;
        pending.photoNote = "фото не нашлось — приложи своё или выбери ссылкой";
        updatePreviewImage();
      }
      return;
    }
    sortTiles();
    applyStockFilter();
    const stock = stockCount();
    setStripStatus(
      `${ready} фото, ${stock ? `стоковых ${stock}` : "стоковых нет"} · листай вправо, жми нужное`,
    );
  };

  const processStrip = async (gen) => {
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < strip.items.length) {
        const index = next++;
        const item = strip.items[index];
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const result = prepareImage(await loadImageWithFallback(item.url));
          item.dataUrl = result.dataUrl;
          item.cut = result.cut;
          item.isStock = result.stock >= STOCK_MIN;
          item.state = "ready";
        } catch {
          item.state = "failed";
        }
        if (gen !== strip.gen) return;
        done++;
        setStripStatus(`Обрабатываю фото… ${done} / ${strip.items.length}`);
        renderTile(index);
        // пока пользователь ничего не выбрал: берём первое готовое, а как появится
        // стоковое (белый/прозрачный фон) — переключаемся на него
        if (item.state === "ready" && pending.photoSource === "auto") {
          const current = strip.items[strip.selected];
          if (strip.selected < 0 || (!current?.isStock && item.isStock)) selectTile(index, "auto");
        }
      }
    };
    await Promise.all(Array.from({ length: STRIP_CONCURRENCY }, worker));
    if (gen === strip.gen) finishStrip();
  };

  const clearStrip = () => {
    strip.gen++;
    strip.key = "";
    strip.items = [];
    strip.selected = -1;
    clearTimeout(strip.timer);
    $("photo-track").innerHTML = "";
    $("photo-strip").hidden = true;
  };

  const refreshPhotos = async ({ force = false } = {}) => {
    const query = photoQuery();
    const key = [query.brand, query.name, query.flavor].join("|").toLowerCase();
    if (key.replace(/\|/g, "").length < 2) {
      clearStrip();
      return;
    }
    if (!force && key === strip.key) return;
    strip.key = key;
    const gen = ++strip.gen;
    strip.items = [];
    strip.selected = -1;
    $("photo-strip").hidden = false;
    $("photo-track").innerHTML = "";
    setStripStatus("Ищу фото…");

    const params = new URLSearchParams();
    for (const [field, value] of Object.entries(query)) if (value) params.set(field, value);
    let images;
    try {
      ({ images } = await api("GET", `api/cabinet/ai/photo-search?${params}`));
    } catch (error) {
      if (gen === strip.gen) setStripStatus(`поиск не ответил: ${error.message}`);
      return;
    }
    if (gen !== strip.gen) return;

    strip.items = (images || []).map((hit) => ({
      url: typeof hit === "string" ? hit : hit.url,
      title: typeof hit === "string" ? "" : hit.title || "",
      state: "loading",
      dataUrl: "",
      cut: false,
      isStock: false,
    }));
    if (!strip.items.length) {
      finishStrip();
      return;
    }
    $("photo-track").innerHTML = "";
    $("photo-track").scrollLeft = 0;
    setStripStatus(`Обрабатываю фото… 0 / ${strip.items.length}`);
    processStrip(gen);
  };

  const schedulePhotos = () => {
    clearTimeout(strip.timer);
    strip.timer = setTimeout(() => refreshPhotos(), STRIP_DEBOUNCE_MS);
  };

  $("photo-track").addEventListener("click", (event) => {
    const tile = event.target.closest(".photo-tile");
    if (tile && !tile.disabled) selectTile(Number(tile.dataset.index), "strip");
  });
  // колесо мыши листает ленту вбок
  $("photo-track").addEventListener(
    "wheel",
    (event) => {
      const track = event.currentTarget;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (track.scrollWidth <= track.clientWidth) return;
      event.preventDefault();
      track.scrollLeft += event.deltaY;
    },
    { passive: false },
  );
  $("btn-photo-refresh").onclick = () => refreshPhotos({ force: true });
  $("photo-stock-only").addEventListener("change", applyStockFilter);

  const retryPhoto = () => {
    const onlyStock = $("photo-track").classList.contains("is-stock-only");
    const ready = strip.items
      .map((item, index) => (item.state === "ready" && (!onlyStock || item.isStock) ? index : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => Number(!strip.items[a].isStock) - Number(!strip.items[b].isStock) || a - b);
    if (!ready.length) {
      $("smart-status").textContent = "Вариантов нет — приложи своё фото или вставь ссылку.";
      return;
    }
    const pos = ready.indexOf(strip.selected);
    const index = ready[(pos + 1) % ready.length];
    selectTile(index, "strip");
    $("photo-track")
      .querySelector(`[data-index="${index}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  };

  // Повторный клик (или ретрай) не должен завести вторую банку: пока запрос летит,
  // второй вызов saveDrink молча выходим.
  let savingDrink = false;
  const saveDrink = async (parsed) => {
    if (savingDrink) return;
    // Защита от дублей: если ИИ нашёл похожую банку, без явного «это не он»
    // новую не заводим — иначе предупреждение проскакивают и плодятся копии.
    if (pending.similarCount && !pending.duplicateAck) {
      $("smart-status").textContent =
        "Похоже на дубликат. Если это правда другой энергос — отметь галочку «Это не тот энергос» выше.";
      return;
    }
    const body = {
      brand: parsed.brand,
      name: parsed.name,
      flavor: parsed.flavor,
      edition: parsed.edition,
      tier: TIERS.includes(parsed.tier) ? parsed.tier : "B",
      review: parsed.review || "",
    };
    // Серверная защита от дублей: явное подтверждение шлём, только если человек
    // реально видел похожие и снял галочку. Иначе сервер сам притормозит 409-й.
    if (pending.similarCount > 0 && pending.duplicateAck) body.confirmDifferent = true;
    if (pending.barcode) body.barcode = pending.barcode;
    if (pending.image && pending.image.startsWith("data:")) body.imageDataUrl = pending.image;
    savingDrink = true;
    try {
      await api("POST", "api/cabinet/drinks", body);
    } finally {
      savingDrink = false;
    }
    resetSmart();
    // Форма и камера остаются на месте, сбрасывается только подтверждение:
    // следующая новая банка снова потребует проверки списка.
    $("dup-gate-status").textContent = "В индексе ✓ — банка добавлена";
    $("smart-status").textContent = "В индексе ✓";
    await refreshAll();
  };

  const resetSmart = () => {
    pending.parsed = null;
    pending.image = null;
    pending.original = null;
    pending.userPhoto = false;
    pending.photoSource = "auto";
    pending.photoNote = "";
    pending.barcode = "";
    pending.rawCode = "";
    clearStrip();
    ["parsed-brand", "parsed-name", "parsed-flavor", "parsed-edition", "parsed-review", "m-image-url"].forEach((id) => {
      $(id).value = "";
    });
    $("parsed-tier").value = "";
    $("parsed-tier-note").textContent = "";
    $("smart-preview").hidden = true;
    $("smart-input").value = "";
    updateSmartButton();
    $("camera-code").value = "";
    setCameraStatus("");
    renderSimilar([]);
    $("dup-gate-search").value = "";
    $("dup-gate-results").hidden = true;
    $("dup-gate-results").innerHTML = "";
    hideDupAck();
    clearVoice("smart");
  };

  // Подтверждение «такого нет в списке» показываем только после неудачных попыток
  // найти банку (поиск, ИИ-разбор, штрих-код) или при попытке сохранить без проверки.
  const syncConfirmState = () => {
    const similarBlock = pending.similarCount > 0 && !pending.duplicateAck;
    const absenceBlock =
      pending.similarCount === 0 && !pending.absenceAck && !$("dup-gate-ack-wrap").hidden;
    $("btn-confirm").disabled = similarBlock || absenceBlock;
  };

  const showDupAck = () => {
    // Когда похожие найдены, работает своя галочка «это не тот энергос».
    if (pending.similarCount) return;
    $("dup-gate-ack-wrap").hidden = false;
    syncConfirmState();
  };

  const hideDupAck = () => {
    $("dup-gate-ack-wrap").hidden = true;
    $("dup-gate-ack").checked = false;
    pending.absenceAck = false;
    syncConfirmState();
  };

  // Если ИИ распознал банку, которая уже есть в индексе, — предлагаем оценить её,
  // а не заводить дубль. Тир и отзыв берём из того же разбора.
  const renderSimilar = (similar) => {
    const box = $("similar-box");
    pending.similarCount = similar.length;
    pending.duplicateAck = !similar.length;
    box.hidden = !similar.length;
    $("similar-ack").checked = false;
    $("similar-ack-wrap").hidden = !similar.length;
    // Похожие найдены — подтверждение «нет в списке» не нужно, хватит «это не тот».
    if (similar.length) hideDupAck();
    // Пока похожие не подтверждены «это не он», кнопка «В индекс» заблокирована.
    syncConfirmState();
    if (!similar.length) {
      $("similar-list").innerHTML = "";
      return;
    }
    $("similar-list").innerHTML = similar
      .map(
        (drink) => `
        <div class="similar-row" data-drink="${esc(drink.slug)}">
          <img src="${esc(drink.image)}" alt="" loading="lazy">
          <div><b>${esc(drink.name)}</b><small>${esc(drink.flavor)}${drink.reason ? ` · ${esc(drink.reason)}` : ""}${drink.myTier ? ` · у тебя уже ${esc(drink.myTier)}` : ""}</small></div>
          <button class="btn" type="button" data-rate-existing>${drink.myTier ? "Обновить оценку" : "Оценить эту"}</button>
        </div>`,
      )
      .join("");
  };

  /* ---------- добавление по штрих-коду ---------- */
  const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "data_matrix"];
  let barcodeBusy = false;

  const setCameraStatus = (text, isError = false) => {
    $("camera-status").textContent = text;
    $("camera-status").style.color = isError ? "#ff8a8a" : "";
  };

  const barcodeNote = (data) => {
    const bits = [`штрих-код ${data.code}`];
    const source = data.product?.source;
    if (source === "openfoodfacts") bits.push("Open Food Facts");
    if (source === "crpt") bits.push("Честный знак");
    if (source === "truemark") bits.push("TrueMark · Честный знак");
    if (source === "barcode-list") bits.push("База штрих-кодов");
    if (source === "index") bits.push("уже в индексе");
    if (data.product?.volume) bits.push(data.product.volume);
    if (data.product?.caffeineMg) bits.push(`${data.product.caffeineMg} мг кофеина`);
    if (data.product?.kcal) bits.push(`${data.product.kcal} ккал`);
    return bits.join(" · ");
  };

  const lookupBarcode = async (code) => {
    if (barcodeBusy || !code) return false;
    barcodeBusy = true;
    const gen = autoScanGen;
    setCameraStatus("🔎 Ищу по коду…");
    try {
      const data = await api("POST", "api/cabinet/ai/barcode", { code });
      if (gen !== autoScanGen || !$("camera-dialog").open || camera.mode !== "code") return false;
      const product = data.product || data.inIndex;
      pending.barcode = data.code;
      pending.rawCode = data.rawCode || "";
      pending.image = null;
      pending.original = null;
      pending.photoSource = "auto";
      if (!product) {
        // Код считан, но товара нет ни в индексе, ни в базах (обычное дело для
        // российских банок): не теряем штрих-код — открываем форму с ним, бренд
        // и название человек впишет сам.
        pending.parsed = { brand: "", name: "", flavor: "", edition: "", tier: "B", tierGuessed: true, review: "" };
        pending.photoNote = "отсканирован код — заполни бренд и название";
        renderSimilar([]);
        showDupAck();
        showPreview();
        $("smart-status").textContent = `штрих-код ${data.code} — товара нет в базах, заполни бренд и название вручную`;
        return true;
      }
      const sourceName = product.name || product.brand || "";
      const longName = sourceName.length > 120;
      pending.parsed = {
        brand: product.brand || product.name || "",
        name: longName ? "" : sourceName,
        flavor: product.flavor || "",
        edition: "",
        tier: "B",
        tierGuessed: true,
        review: "",
      };
      pending.photoNote = data.inIndex ? "банка уже в индексе" : "фото не нашлось — ищу по названию";
      renderSimilar(data.similar || []);
      // Код не нашёлся в индексе — неудачная попытка, просим подтвердить отсутствие.
      if (!(data.similar || []).length) showDupAck();
      if (data.product?.image) {
        const label = { truemark: "TrueMark", openfoodfacts: "Open Food Facts", index: "индекса", crpt: "Честного знака" }[data.product.source] || "источника";
        const selection = pending.parsed;
        const current = () => pending.parsed === selection && pending.barcode === data.code &&
          pending.rawCode === (data.rawCode || "") && pending.photoSource === "barcode";
        pending.photoSource = "barcode";
        pending.photoNote = `фото ${label} · фон режется…`;
        processImageUrl(data.product.source === "truemark" ? proxiedPhotoUrl(data.product.image) : data.product.image)
          .then((dataUrl) => {
            if (!current()) return;
            pending.image = dataUrl;
            pending.photoNote = `фото ${label} ✓`;
            updatePreviewImage();
          })
          .catch(() => {
            if (!current()) return;
            pending.photoNote = `фото из ${label} не загрузилось`;
            updatePreviewImage();
          });
      }
      $("smart-status").textContent = data.inIndex
        ? "уже в индексе — жми «Оценить эту» выше"
        : barcodeNote(data);
      if (longName) $("smart-status").textContent += ` · Название источника: ${sourceName}. Введи краткое название до 120 символов — исходное не обрезано.`;
      showPreview();
      refreshPhotos();
      return true;
    } catch (error) {
      if (gen !== autoScanGen) return false;
      setCameraStatus(error.message, true);
      return false;
    } finally {
      barcodeBusy = false;
    }
  };

  // Форматы, которые реально умеет браузер; пусто — BarcodeDetector недоступен.
  const barcodeFormats = async () => {
    if (!("BarcodeDetector" in window)) return [];
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      return BARCODE_FORMATS.filter((format) => supported.includes(format));
    } catch {
      return [];
    }
  };

  // ZXing из vendor — страховка для устройств, где BarcodeDetector нет или он молчит
  // (Firefox/Safari, Android без сервисов Google). Грузится лениво, только при скане.
  let zxingReader = null;
  let zxingLoading = null;
  const loadZXing = () => {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    zxingLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/zxing.min.js";
      script.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error("сканер не инициализировался")));
      script.onerror = () => reject(new Error("сканер не загрузился"));
      document.head.appendChild(script);
    }).catch((error) => {
      zxingLoading = null;
      throw error;
    });
    return zxingLoading;
  };

  const ensureZXingReader = () => {
    if (zxingReader) return Promise.resolve(zxingReader);
    return loadZXing().then((zx) => {
      const hints = new Map();
      hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [
        zx.BarcodeFormat.EAN_13,
        zx.BarcodeFormat.EAN_8,
        zx.BarcodeFormat.UPC_A,
        zx.BarcodeFormat.UPC_E,
        zx.BarcodeFormat.CODE_128,
        zx.BarcodeFormat.DATA_MATRIX,
      ]);
      hints.set(zx.DecodeHintType.TRY_HARDER, true);
      zxingReader = new zx.MultiFormatReader();
      zxingReader.setHints(hints);
      return zxingReader;
    });
  };

  // ZXing ждёт яркость (Y) — считаем её сами из RGBA кадра.
  const zxingDecode = (canvas) => {
    if (!canvas || !zxingReader) return "";
    const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const gray = new Uint8ClampedArray(image.width * image.height);
    for (let i = 0, j = 0; i < image.data.length; i += 4, j++) {
      gray[j] = (image.data[i] * 299 + image.data[i + 1] * 587 + image.data[i + 2] * 114) / 1000;
    }
    const zx = window.ZXing;
    const source = new zx.PlanarYUVLuminanceSource(
      gray,
      image.width,
      image.height,
      0,
      0,
      image.width,
      image.height,
      false,
    );
    try {
      const result = zxingReader.decodeWithState(new zx.BinaryBitmap(new zx.HybridBinarizer(source)));
      return result?.getText() || "";
    } catch {
      return "";
    } finally {
      zxingReader.reset();
    }
  };

  // zxing-wasm из vendor — сильный локальный декодер: тот же рецепт, что на сервере
  // (raw, затем Otsu-порог с инверсией). Лениво; начальный GS сохраняем как есть.
  const WASM_DECODE_OPTIONS = {
    formats: ["DataMatrix", "EAN13", "EAN8", "UPCA", "UPCE", "Code128"],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDenoise: true,
    tryDownscale: true,
    maxNumberOfSymbols: 1,
    textMode: "Plain",
  };

  let wasmLoading = null;
  const loadZXingWasm = () => {
    if (window.ZXingWASM) return Promise.resolve(window.ZXingWASM);
    wasmLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/zxing-wasm/reader.js";
      script.onload = () =>
        window.ZXingWASM ? resolve(window.ZXingWASM) : reject(new Error("wasm-сканер не инициализировался"));
      script.onerror = () => reject(new Error("wasm-сканер не загрузился"));
      document.head.appendChild(script);
    })
      .then((wasm) => {
        wasm.setZXingModuleOverrides({ locateFile: (file) => `vendor/zxing-wasm/${file}` });
        return wasm;
      })
      .catch((error) => {
        wasmLoading = null;
        throw error;
      });
    return wasmLoading;
  };

  // Otsu: порог между «тёмным» и «светлым» по гистограмме серого.
  const otsuThreshold = (gray) => {
    const histogram = new Array(256).fill(0);
    for (const value of gray) histogram[value]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * histogram[i];
    let dark = 0;
    let sumDark = 0;
    let best = 0;
    let threshold = 0;
    for (let i = 0; i < 256; i++) {
      dark += histogram[i];
      if (!dark) continue;
      const light = total - dark;
      if (!light) break;
      sumDark += i * histogram[i];
      const between = dark * light * (sumDark / dark - (sum - sumDark) / light) ** 2;
      if (between > best) {
        best = between;
        threshold = i;
      }
    }
    return threshold;
  };

  const wasmRead = async (image) => {
    const wasm = await loadZXingWasm();
    const results = await wasm.readBarcodes(image, WASM_DECODE_OPTIONS);
    return results?.find((item) => item?.isValid && item.text)?.text || "";
  };

  let wasmDecoding = false;
  // Максимум две wasm-попытки: raw, затем Otsu-инверсия (рецепт для бликующей
  // крышки банки). Пока decode идёт, новые кадры не стакуются.
  const wasmDecode = async (canvas) => {
    if (!canvas || wasmDecoding) return "";
    wasmDecoding = true;
    try {
      const image = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const direct = await wasmRead(image);
      if (direct) return direct;
      const gray = new Uint8ClampedArray(image.width * image.height);
      for (let i = 0, j = 0; i < image.data.length; i += 4, j++) {
        gray[j] = (image.data[i] * 299 + image.data[i + 1] * 587 + image.data[i + 2] * 114) / 1000;
      }
      const threshold = otsuThreshold(gray);
      const inverted = new ImageData(image.width, image.height);
      for (let i = 0, j = 0; i < image.data.length; i += 4, j++) {
        const value = gray[j] > threshold ? 0 : 255;
        inverted.data[i] = inverted.data[i + 1] = inverted.data[i + 2] = value;
        inverted.data[i + 3] = 255;
      }
      return await wasmRead(inverted);
    } catch {
      return "";
    } finally {
      wasmDecoding = false;
    }
  };

  // Сначала быстрый нативный детектор, затем локальный wasm, при осечке — legacy
  // ZXing (в т.ч. в Firefox/Safari, где BarcodeDetector нет).
  const detectBarcode = async (source) => {
    const formats = await barcodeFormats();
    if (formats.length) {
      try {
        const found = await new window.BarcodeDetector({ formats }).detect(source);
        const code = found?.[0]?.rawValue || "";
        if (code) return code;
      } catch {
        /* кадр не по зубам нативному API — пробуем дальше */
      }
    }
    const wasm = await wasmDecode(scanVariant(source, 0, 1920));
    if (wasm) return wasm;
    try {
      await ensureZXingReader();
    } catch {
      return "";
    }
    for (let index = 0; index < 6; index++) {
      const code = zxingDecode(scanVariant(source, index, index === 0 ? 1920 : 1280));
      if (code) return code;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return "";
  };

  // Фото → canvas ≤1600px, jpeg: маленький размер для серверного разбора.
  const barcodeImageDataUrl = async (file, maxSide = 1600) => {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await loadImage(objectUrl);
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.92);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  /* ---------- камера ---------- */
  const camera = { stream: null, mode: "can", busy: false, torch: false };

  let autoScanTimer = null;
  let autoScanGen = 0;

  const stopAutoScan = () => {
    autoScanGen++;
    clearTimeout(autoScanTimer);
    autoScanTimer = null;
  };

  const NATIVE_GRACE_MS = 2500;
  const SCAN_INTERVAL_MS = 150;
  // Серверный фолбэк — последний шанс: локальный wasm обычно быстрее, поэтому
  // реже, раз в 4 c, не больше 24 кадров за сессию.
  const SERVER_SCAN_MS = 4000;
  const SERVER_SCAN_MAX = 24;
  const SERVER_SCAN_SIDE = 1024;
  // Один ограниченный вариант за live-tick; полный кадр чередуется с ROI,
  // поэтому код у края кадра не теряется из-за object-fit/crop.
  const scanVariant = (video, index, maxSide = 1280) => {
    const sw = video.videoWidth || video.width;
    const sh = video.videoHeight || video.height;
    if (!sw || !sh) return null;
    const roi = index % 2 === 1;
    const width = roi ? sw / 2 : sw;
    const height = roi ? sh / 2 : sh;
    const scale = Math.min(2, maxSide / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    context.drawImage(video, (sw - width) / 2, (sh - height) / 2, width, height, 0, 0, canvas.width, canvas.height);
    if (index >= 2) {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < image.data.length; i += 4) {
        const gray = (image.data[i] * 299 + image.data[i + 1] * 587 + image.data[i + 2] * 114) / 1000;
        const value = index >= 4 ? 255 - gray : (gray - 128) * 1.6 + 128;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
      }
      context.putImageData(image, 0, 0);
    }
    return canvas;
  };

  // Кадр на сервер: ограниченный JPEG, один запрос за раз. Ошибки глушим —
  // live-цикл не должен падать из-за сети.
  let serverScanBusy = false;
  const serverScanFrame = async () => {
    if (serverScanBusy || camera.busy || barcodeBusy) return "";
    const canvas = scanVariant($("camera-video"), 0, SERVER_SCAN_SIDE);
    if (!canvas) return "";
    serverScanBusy = true;
    try {
      const imageDataUrl = canvas.toDataURL("image/jpeg", 0.85);
      const result = await api("POST", "api/cabinet/ai/barcode-scan", { imageDataUrl });
      return result?.found ? result.code : "";
    } catch {
      return "";
    } finally {
      serverScanBusy = false;
    }
  };

  // Живой скан не ждёт загрузки декодера и сети. Синхронная работа WASM/ZXing
  // всё ещё занимает главный поток; promise-цепочки не заменяют Web Worker.
  const startAutoScan = async () => {
    stopAutoScan();
    const gen = autoScanGen;
    if (camera.mode !== "code") return;
    const formats = await barcodeFormats();
    if (gen !== autoScanGen || camera.mode !== "code" || !$("camera-dialog").open) return;

    const startedAt = Date.now();
    const detector = formats.length ? new window.BarcodeDetector({ formats }) : null;
    let variant = 0;
    let serverAttempts = 0;
    let serverAt = startedAt;
    let liveNativeJob = null;
    let liveWasmJob = null;
    let liveServerJob = null;
    let scanResultBusy = false;

    const acceptScannedCode = (code, resultGen = gen) => {
      if (
        !code ||
        resultGen !== autoScanGen ||
        camera.mode !== "code" ||
        !$("camera-dialog").open ||
        scanResultBusy || camera.busy || barcodeBusy
      ) return false;
      scanResultBusy = true;
      stopAutoScan();
      const lookupGen = autoScanGen;
      camera.busy = true;
      Promise.resolve().then(() => lookupBarcode(code))
        .then((found) => {
          if (found && lookupGen === autoScanGen && camera.mode === "code" && $("camera-dialog").open) closeCamera();
          if (!found && lookupGen === autoScanGen && camera.mode === "code" && $("camera-dialog").open) {
            // Код прочитан, но товара нет — даём шанс переснять.
            $("btn-camera-shoot").hidden = false;
            $("btn-camera-shoot").textContent = "↻ Сканировать снова";
          }
        })
        .catch(() => {})
        .finally(() => {
          camera.busy = false;
          scanResultBusy = false;
        });
      return true;
    };

    const startWasmJob = (canvas) => {
      if (liveWasmJob || wasmDecoding || scanResultBusy || gen !== autoScanGen) return;
      liveWasmJob = Promise.resolve()
        .then(() => gen === autoScanGen ? wasmDecode(canvas) : "")
        .then((code) => {
          if (gen !== autoScanGen) return "";
          return code || zxingDecode(canvas);
        })
        .then((code) => acceptScannedCode(code, gen))
        .catch(() => {})
        .finally(() => { liveWasmJob = null; });
    };

    const startServerJob = () => {
      if (liveServerJob || serverScanBusy || scanResultBusy || gen !== autoScanGen) return;
      serverAt = Date.now();
      serverAttempts++;
      setCameraStatus("🔎 Смотрю кадр внимательнее…");
      liveServerJob = Promise.resolve().then(() => gen === autoScanGen ? serverScanFrame() : "")
        .then((code) => acceptScannedCode(code, gen))
        .then((accepted) => {
          if (!accepted && gen === autoScanGen && camera.mode === "code" && $("camera-dialog").open) {
            setCameraStatus("🔎 Ищу код — просто наведи камеру");
          }
        })
        .catch(() => {})
        .finally(() => { liveServerJob = null; });
    };

    if (!formats.length) {
      // Нативного детектора нет: загрузку локальных читалок не ждём, чтобы
      // первый кадр не стоял на месте; tick продолжает работать немедленно.
      setCameraStatus("🔎 Ищу код — просто наведи камеру");
      Promise.allSettled([ensureZXingReader(), loadZXingWasm()]).then(() => {
        if (gen === autoScanGen && camera.mode === "code" && $("camera-dialog").open && !zxingReader && !window.ZXingWASM) {
          setCameraStatus("Этот браузер не умеет читать коды — введи код вручную.", true);
          $("camera-code").focus();
        }
      }).catch(() => {});
    } else {
      setCameraStatus("🔎 Ищу код — просто наведи камеру");
    }

    const tick = () => {
      if (gen !== autoScanGen || camera.mode !== "code" || !$("camera-dialog").open || camera.busy || barcodeBusy) return;
      const canvas = scanVariant($("camera-video"), variant++ % 6);
      if (!canvas) {
        autoScanTimer = setTimeout(tick, 300);
        return;
      }

      // Один native-запрос за раз: зависший детектор не копит очередь кадров
      // и не мешает независимым wasm/server попыткам.
      if (detector && !liveNativeJob) {
        liveNativeJob = Promise.resolve().then(() => gen === autoScanGen ? detector.detect(canvas) : [])
          .then((found) => acceptScannedCode(found?.[0]?.rawValue || "", gen))
          .catch(() => {})
          .finally(() => { liveNativeJob = null; });
        if (!zxingReader && Date.now() - startedAt > NATIVE_GRACE_MS) void ensureZXingReader().catch(() => {});
      }

      startWasmJob(canvas);

      if (
        !scanResultBusy &&
        !liveServerJob &&
        serverAttempts < SERVER_SCAN_MAX &&
        Date.now() - serverAt >= SERVER_SCAN_MS
      ) startServerJob();

      if (gen === autoScanGen && camera.mode === "code" && $("camera-dialog").open && !camera.busy) {
        autoScanTimer = setTimeout(tick, SCAN_INTERVAL_MS);
      }
    };
    autoScanTimer = setTimeout(tick, 300);
  };
  const stopCamera = () => {
    camera.stream?.getTracks().forEach((track) => track.stop());
    camera.stream = null;
    $("camera-video").srcObject = null;
  };

  // Фонарик (torch) есть не на каждой камере: включаем только если трек умеет.
  const setCameraTorch = async (on) => {
    const track = camera.stream?.getVideoTracks?.()[0];
    if (!track) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      camera.torch = on;
      const button = $("camera-torch");
      button.classList.toggle("is-active", on);
      button.textContent = on ? "🔦 Фонарик вкл" : "🔦 Фонарик";
      return true;
    } catch {
      setCameraStatus("Фонарик здесь не включается.", true);
      return false;
    }
  };

  const setCameraMode = (mode) => {
    camera.mode = mode;
    document.querySelectorAll("[data-camera-mode]").forEach((button) => {
      const active = button.dataset.cameraMode === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("camera-stencil").dataset.mode = mode;
    $("camera-manual").hidden = mode !== "code";
    $("camera-hint").textContent =
      mode === "code" ? "Data Matrix обычно на верху банки: поднеси ближе, без бликов. Квадрат — ориентир; EAN тоже читается во всём кадре." : "Наведи банку по контуру и жми «Снять»";
    const shoot = $("btn-camera-shoot");
    shoot.hidden = mode === "code";
    shoot.textContent = "● Снять";
    if (mode === "code") startAutoScan();
    else {
      stopAutoScan();
      setCameraStatus("");
    }
  };

  const startCamera = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("Камера тут недоступна — выбери фото из галереи.", true);
      $("btn-camera-shoot").disabled = true;
      return;
    }
    try {
      camera.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      const video = $("camera-video");
      video.srcObject = camera.stream;
      await video.play().catch(() => {});
      const track = camera.stream.getVideoTracks()[0];
      if (track?.getCapabilities?.()?.focusMode?.includes("continuous")) {
        await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      }
      $("camera-torch").hidden = !track?.getCapabilities?.()?.torch;
      $("btn-camera-shoot").disabled = false;
    } catch {
      setCameraStatus("Нет доступа к камере — выбери фото из галереи.", true);
      $("btn-camera-shoot").disabled = true;
    }
  };

  const openCamera = async () => {
    setCameraMode("can");
    $("camera-code").value = "";
    setCameraStatus("");
    camera.torch = false;
    $("camera-torch").hidden = true;
    $("camera-torch").classList.remove("is-active");
    $("camera-torch").textContent = "🔦 Фонарик";
    $("camera-dialog").showModal();
    document.body.classList.add("is-dialog-open");
    await startCamera();
  };

  const closeCamera = () => {
    stopAutoScan();
    if ($("camera-dialog").open) $("camera-dialog").close();
  };

  // CSS-трафарет → пиксели кадра: учитываем object-fit: cover и центрирование.
  const cropToStencil = (frame) => {
    const video = $("camera-video");
    const view = $("camera-view").getBoundingClientRect();
    const rect = frame.getBoundingClientRect();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.max(view.width / vw, view.height / vh);
    const offsetX = (view.width - vw * scale) / 2;
    const offsetY = (view.height - vh * scale) / 2;
    const sx = Math.min(Math.max(0, (rect.left - view.left - offsetX) / scale), vw);
    const sy = Math.min(Math.max(0, (rect.top - view.top - offsetY) / scale), vh);
    const sw = Math.min(vw - sx, rect.width / scale);
    const sh = Math.min(vh - sy, rect.height / scale);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  $("btn-camera-shoot").onclick = async () => {
    if (camera.busy) return;
    if (camera.mode === "code") {
      $("btn-camera-shoot").hidden = true;
      startAutoScan();
      return;
    }
    const video = $("camera-video");
    if (!video.videoWidth || !video.videoHeight) {
      setCameraStatus("Кадр ещё не готов — подожди секунду.");
      return;
    }
    const frame = document.querySelector(".camera-stencil__can");
    camera.busy = true;
    $("btn-camera-shoot").disabled = true;
    try {
      const canvas = cropToStencil(frame);
      setCameraStatus("📷 Обрабатываю фото…");
      const img = await loadImage(canvas.toDataURL("image/jpeg", 0.92));
      pending.original = shrinkOnly(img);
      const { dataUrl, cut } = prepareImage(img);
      pending.image = dataUrl;
      pending.userPhoto = true;
      pending.photoSource = "camera";
      pending.photoNote = cut ? "фото с камеры · фон вырезан ✓" : "фото с камеры ✓";
      strip.selected = -1;
      markSelected();
      updatePreviewImage();
      closeCamera();
      $("smart-status").textContent = "Фото с камеры готово ✓";
    } catch (error) {
      setCameraStatus(error.message || "Не удалось обработать кадр.", true);
    } finally {
      camera.busy = false;
      $("btn-camera-shoot").disabled = false;
    }
  };

  $("camera-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || camera.busy || barcodeBusy) return;
    if (camera.mode === "code") {
      stopAutoScan();
      const gen = autoScanGen;
      camera.busy = true;
      setCameraStatus("📷 Читаю код с фото…");
      try {
        const bitmap = await createImageBitmap(file);
        let code = await detectBarcode(bitmap);
        bitmap.close?.();
        if (gen !== autoScanGen) return;
        if (!code) {
          // Клиент не осилил (блик/смаз) — последний шанс: серверный разбор.
          setCameraStatus("всматриваюсь внимательнее…");
          const imageDataUrl = await barcodeImageDataUrl(file);
          const result = await api("POST", "api/cabinet/ai/barcode-scan", { imageDataUrl });
          if (result.found) code = result.code;
        }
        if (gen !== autoScanGen) return;
        if (!code) {
          setCameraStatus("Код не распознан — попробуй ближе и без бликов.", true);
          return;
        }
        if (await lookupBarcode(code)) closeCamera();
      } catch (error) {
        if (gen === autoScanGen) setCameraStatus(error.message || "не удалось прочитать код", true);
      } finally {
        camera.busy = false;
        restoreScanRetry(gen);
      }
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await loadImage(objectUrl);
      pending.original = shrinkOnly(img);
      const { dataUrl, cut } = prepareImage(img);
      pending.image = dataUrl;
      pending.userPhoto = true;
      pending.photoSource = "camera";
      pending.photoNote = cut ? "фото из галереи · фон вырезан ✓" : "фото из галереи ✓";
      strip.selected = -1;
      markSelected();
      updatePreviewImage();
      closeCamera();
      $("smart-status").textContent = "Фото приложено ✓";
    } catch {
      setCameraStatus("Не смог прочитать файл.", true);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  });

  const restoreScanRetry = (gen) => {
    if (gen !== autoScanGen || !$("camera-dialog").open || camera.mode !== "code") return;
    $("btn-camera-shoot").hidden = false;
    $("btn-camera-shoot").disabled = false;
    $("btn-camera-shoot").textContent = "↻ Сканировать снова";
  };

  $("camera-code").addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const code = $("camera-code").value.trim();
    if (!code || camera.busy || barcodeBusy) return;
    stopAutoScan();
    const gen = autoScanGen;
    try {
      if (await lookupBarcode(code)) closeCamera();
    } finally {
      restoreScanRetry(gen);
    }
  });

  $("camera-torch").onclick = async () => {
    const button = $("camera-torch");
    button.disabled = true;
    try {
      await setCameraTorch(!camera.torch);
    } finally {
      button.disabled = false;
    }
  };

  document.querySelectorAll("[data-camera-mode]").forEach((button) => {
    button.addEventListener("click", () => setCameraMode(button.dataset.cameraMode));
  });

  $("camera-close").onclick = closeCamera;
  $("camera-dialog").addEventListener("click", (event) => {
    if (event.target === $("camera-dialog")) closeCamera();
  });
  $("camera-dialog").addEventListener("close", () => {
    document.body.classList.remove("is-dialog-open");
    stopAutoScan();
    stopCamera();
  });
  $("btn-camera").onclick = openCamera;

  // Разбор ИИ не сохраняем молча: открываем редактор с готовым тиром и отзывом —
  // можно поправить текст, приложить фото и только потом опубликовать.
  $("similar-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-rate-existing]");
    if (!button || !pending.parsed) return;
    const slug = button.closest(".similar-row").dataset.drink;
    const parsed = pending.parsed;
    openOpinion(slug, {
      tier: TIERS.includes(parsed.tier) ? parsed.tier : "B",
      review: parsed.review || "",
      aiText: $("smart-input").value.trim(),
      fromSmart: true,
    });
  });

  // Снимаем блокировку только явной галочкой. Кнопка «Оценить эту» рядом —
  // правильный путь при дубле.
  $("similar-ack").addEventListener("change", (event) => {
    pending.duplicateAck = event.target.checked;
    syncConfirmState();
  });

  /* ---------- гейт «такого нет в списке» ---------- */
  // Форму добавления не показываем, пока человек не подтвердит, что проверил
  // индекс. Рядом — быстрый поиск: если банка нашлась, открываем её редактор.
  const DUP_GATE_PAGE = 6;

  const renderDupGateResults = () => {
    const box = $("dup-gate-results");
    const needle = $("dup-gate-search").value.trim().toLowerCase();
    if (!needle || !state.summary) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    const words = needle.split(/\s+/).filter(Boolean);
    const list = state.summary.drinks
      .filter((drink) =>
        words.every((word) =>
          [drink.brand, drink.name, drink.flavor, drink.edition]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(word),
        ),
      )
      .slice(0, DUP_GATE_PAGE);
    box.hidden = false;
    if (list.length) hideDupAck();
    box.innerHTML = list.length
      ? list
          .map((drink) => {
            const mine = state.mine.find((row) => row.drink === drink.id);
            return `
        <div class="dup-gate__row" data-drink="${esc(drink.id)}">
          <img src="${esc(drink.image)}" alt="" loading="lazy">
          <div><b>${esc(drink.name)}</b><small>${esc(drink.flavor)}${mine ? ` · у тебя ${esc(mine.tier)}` : ""}</small></div>
          <button class="btn btn--ghost" type="button" data-rate-found>Это она — оценить</button>
        </div>`;
          })
          .join("")
      : `<p class="hint">Ничего не нашлось — если банки точно нет, отметь галочку ниже.</p>`;
    // Поиск не нашёл банку — это неудачная попытка: показываем подтверждение.
    if (!list.length) showDupAck();
  };

  $("dup-gate-search").addEventListener("input", renderDupGateResults);
  $("dup-gate-results").addEventListener("click", (event) => {
    const button = event.target.closest("[data-rate-found]");
    if (!button) return;
    openOpinion(button.closest(".dup-gate__row").dataset.drink);
  });
  $("dup-gate-ack").addEventListener("change", (event) => {
    pending.absenceAck = event.target.checked;
    if (event.target.checked) $("dup-gate-status").textContent = "";
    syncConfirmState();
  });

  let smartBusy = false;
  const updateSmartButton = () => {
    $("btn-smart").disabled = smartBusy || !$("smart-input").value.trim();
  };
  $("smart-input").addEventListener("input", updateSmartButton);

  const submitSmart = async (event) => {
    event.preventDefault();
    if (smartBusy) return;
    const text = $("smart-input").value.trim();
    if (!text) {
      $("smart-status").textContent = "Напиши хоть пару слов или надиктуй войсом.";
      return;
    }
    smartBusy = true;
    updateSmartButton();
    $("smart-status").textContent = "✦ Обрабатываю текст…";
    try {
      // Черновик из QR/штрих-кода и уже прикреплённое фото уходят вместе с текстом:
      // ИИ видит банку и уточняет поля, не стирая то, что уже известно.
      const draft = pending.parsed
        ? {
            brand: pending.parsed.brand || "",
            name: pending.parsed.name || "",
            flavor: pending.parsed.flavor || "",
            edition: pending.parsed.edition || "",
          }
        : null;
      const body = { text };
      if (draft && (draft.brand || draft.name || draft.flavor || draft.edition)) body.draft = draft;
      const photo = pending.original || (pending.image?.startsWith("data:") ? pending.image : "");
      if (photo) body.imageDataUrl = photo;
      const { parsed, similar } = await api("POST", "api/cabinet/ai/parse", body);
      pending.parsed = parsed;
      renderSimilar(similar || []);
      // Разбор не нашёл похожих — показываем подтверждение «такого нет в списке».
      if (!(similar || []).length) showDupAck();
      // Фото из QR/камеры/ленты остаётся выбранным; автоподбор ленты — только когда фото нет.
      if (!pending.userPhoto && pending.photoSource === "auto") {
        pending.image = null;
        pending.original = null;
        pending.photoSource = "auto";
        pending.photoNote = "Ищу фото…";
      }
      showPreview();
      $("smart-status").textContent = "";
      refreshPhotos();
    } catch (error) {
      // Разбор упал — уже полученные из QR данные не стираем.
      if (!pending.parsed) {
        pending.parsed = { brand: "", name: "", flavor: "", edition: "", tier: "B", tierGuessed: true, review: "" };
      }
      renderSimilar([]);
      // Разбор не удался — это тоже неудачная попытка, просим подтвердить отсутствие.
      showDupAck();
      showPreview();
      $("smart-status").textContent = `${error.message}. Заполни поля в карточке и жми «В индекс ✓».`;
    } finally {
      smartBusy = false;
      updateSmartButton();
    }
  };

  $("smart-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $("smart-form").requestSubmit();
    }
  });

  $("smart-form").addEventListener("submit", submitSmart);
  $("btn-confirm").onclick = async () => {
    if (!pending.parsed || $("btn-confirm").disabled) return;
    const parsed = readPreviewFields();
    if (!parsed.brand || !parsed.name) {
      $("smart-status").textContent = "Нужны хотя бы бренд и название.";
      return;
    }
    // Ни поиска, ни разбора не было, «нет в списке» не подтверждали — показываем
    // галочку (она появляется после неудачных попыток найти банку).
    if (!pending.similarCount && !pending.absenceAck) {
      showDupAck();
      $("dup-gate-ack-wrap").scrollIntoView({ behavior: "smooth", block: "center" });
      $("dup-gate-ack").focus();
      $("smart-status").textContent =
        "Проверь список: если такой банки точно нет — отметь галочку выше и жми «В индекс ✓» ещё раз.";
      return;
    }
    $("btn-confirm").disabled = true;
    $("smart-status").textContent = "Сохраняю…";
    try {
      await saveDrink(parsed);
    } catch (error) {
      // Сервер перепроверил дубли и вернул похожие: показываем их и просим
      // подтвердить, что банка новая, — без галочки сохранение не пройдёт.
      if (error.payload?.similar?.length) {
        pending.parsed = parsed;
        renderSimilar(error.payload.similar);
        showPreview();
        $("smart-status").textContent =
          "Похоже, такая банка уже есть. Открой её сверху — или отметь «Это не тот энергос», если это правда другой энергос.";
      } else {
        $("smart-status").textContent = error.message;
      }
    } finally {
      syncConfirmState();
    }
  };
  $("btn-retry-photo").onclick = retryPhoto;

  for (const [id, field] of [
    ["parsed-brand", "brand"],
    ["parsed-name", "name"],
    ["parsed-flavor", "flavor"],
    ["parsed-edition", "edition"],
    ["parsed-tier", "tier"],
    ["parsed-review", "review"],
  ]) {
    $(id).addEventListener("input", (event) => {
      if (!pending.parsed) return;
      pending.parsed[field] = event.target.value;
      if (field === "tier") pending.parsed.tierGuessed = false;
      updateTierNote();
      if (["brand", "name", "flavor"].includes(field)) schedulePhotos();
    });
  }

  $("btn-manual-url").onclick = async () => {
    const url = $("m-image-url").value.trim();
    if (!url) return;
    try {
      pending.image = await processImageUrl(url);
      pending.photoSource = "url";
      pending.photoNote = "фото по ссылке ✓";
      strip.selected = -1;
      markSelected();
    } catch {
      pending.photoNote = "не удалось загрузить фото по ссылке (сайт не отдаёт картинку)";
    }
    updatePreviewImage();
    if (!pending.parsed) {
      $("smart-status").textContent = pending.photoSource === "url" ? "Фото взято ✓" : pending.photoNote;
    }
  };

  $("btn-redraw").onclick = () =>
    redrawCurrentPhoto({
      // Шлём НЕОБРАБОТАННЫЙ оригинал: лента — ужатый исходник по ссылке,
      // своё/по ссылке/повтор — сохранённый оригинал, а не резаный.
      get: async () => {
        if (strip.selected >= 0 && strip.items[strip.selected]?.url) {
          return originalDataUrl(strip.items[strip.selected].url);
        }
        if (pending.original) return pending.original;
        const url = $("m-image-url").value.trim();
        if (pending.photoSource === "url" && url) return originalDataUrl(url);
        return null;
      },
      set: ({ dataUrl, cut, note }) => {
        pending.image = dataUrl;
        pending.photoSource = "redraw";
        pending.photoNote = note || (cut ? "перерисовано 🍌 · фон снят ✓" : "перерисовано 🍌 · фон снять не вышло");
        strip.selected = -1;
        markSelected();
        updatePreviewImage();
        $("smart-status").textContent = "Банка перерисована ✓";
      },
      button: $("btn-redraw"),
      say: (text) => {
        $("smart-status").textContent = text;
      },
    });

  /* ---------- voice ---------- */
  // Запись через MediaRecorder, распознавание — на сервере (Whisper через OpenRouter).
  // Один рекордер обслуживает два места: смарт-форму и редактор мнения.
  const MAX_RECORD_MS = 120_000;
  const VOICE_UI = {
    smart: {
      button: "btn-record",
      status: "voice-status",
      player: "voice-player",
      audio: "voice-audio",
      duration: "voice-duration",
      retry: "btn-voice-retry",
      clear: "btn-voice-clear",
      input: "smart-input",
      label: "🎙 Голос",
      done: "Голос распознан ✓ Проверь текст и жми «Обработать».",
    },
    opinion: {
      button: "op-record",
      status: "op-voice-status",
      player: "op-voice-player",
      audio: "op-voice-audio",
      duration: "op-voice-duration",
      retry: "op-voice-retry",
      clear: "op-voice-clear",
      input: "op-ai-text",
      label: "🎙 Голос",
      done: "Голос распознан ✓ Проверь текст и жми «Разобрать».",
    },
  };
  let voiceTarget = "smart";
  const voiceUi = (target = voiceTarget) => VOICE_UI[target];
  const voice = {
    recorder: null,
    stream: null,
    chunks: [],
    recording: false,
    startedAt: 0,
    durationMs: 0,
    timer: null,
    blob: null,
    url: "",
    busy: false,
  };

  const fmtTime = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  const pickMimeType = () => {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    return (
      ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      ) || ""
    );
  };

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Не удалось прочитать запись"));
      reader.readAsDataURL(blob);
    });

  const setRecordButton = (recording) => {
    const button = $(voiceUi().button);
    button.classList.toggle("btn--recording", recording);
    button.textContent = recording ? "■ Стоп" : voiceUi().label;
  };

  const clearVoice = (target = voiceTarget) => {
    const ui = voiceUi(target);
    if (voice.url) URL.revokeObjectURL(voice.url);
    voice.url = "";
    voice.blob = null;
    voice.durationMs = 0;
    const audio = $(ui.audio);
    audio.removeAttribute("src");
    audio.load();
    $(ui.player).hidden = true;
    $(ui.retry).hidden = true;
    $(ui.status).textContent = "";
  };

  // У webm из MediaRecorder в заголовке нет длительности: браузер отдаёт Infinity и плеер пишет 0:00.
  // Прыжок в «бесконечность» заставляет его просканировать файл и вычислить настоящую длительность.
  const fixDuration = (audio) => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return;
    const reset = () => {
      if (!Number.isFinite(audio.duration)) return;
      audio.removeEventListener("durationchange", reset);
      audio.currentTime = 0;
    };
    audio.addEventListener("durationchange", reset);
    try {
      audio.currentTime = Number.MAX_SAFE_INTEGER;
    } catch {
      /* плеер ещё не готов — останется наш таймер */
    }
  };

  const showRecording = () => {
    const ui = voiceUi();
    const audio = $(ui.audio);
    voice.url = URL.createObjectURL(voice.blob);
    audio.addEventListener("loadedmetadata", () => fixDuration(audio), { once: true });
    audio.src = voice.url;
    $(ui.duration).textContent = fmtTime(voice.durationMs);
    $(ui.player).hidden = false;
  };

  const transcribe = async () => {
    const ui = voiceUi();
    if (!voice.blob || voice.busy) return;
    const status = $(ui.status);
    voice.busy = true;
    $(ui.button).disabled = true;
    $(ui.retry).hidden = true;
    status.textContent = "🎙 Обрабатываю голос…";
    try {
      const audio = await blobToBase64(voice.blob);
      const { text } = await api("POST", "api/cabinet/ai/transcribe", {
        audio,
        mimeType: voice.blob.type || "audio/webm",
      });
      const area = $(ui.input);
      area.value = (area.value.trim() ? `${area.value.trim()} ` : "") + text;
      status.textContent = ui.done;
      autoGrow(area);
      voiceTarget === "smart" ? updateSmartButton() : updateOpButton();
      area.focus();
    } catch (error) {
      console.error("[nrgindex] распознавание не удалось:", error);
      const detail = [error.message || "Распознавание не удалось", error.code ? `код ${error.code}` : ""]
        .filter(Boolean)
        .join(" · ");
      status.textContent = `${detail}. Можно повторить или вписать текст руками.`;
      $(ui.retry).hidden = false;
    } finally {
      voice.busy = false;
      $(ui.button).disabled = false;
    }
  };

  const stopRecording = () => {
    if (!voice.recording) return;
    voice.recording = false;
    voice.durationMs = Date.now() - voice.startedAt;
    clearInterval(voice.timer);
    setRecordButton(false);
    voice.recorder?.stop();
  };

  const startRecording = async () => {
    const status = $(voiceUi().status);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      status.textContent = "Браузер не умеет записывать звук — впиши текст руками.";
      return;
    }
    try {
      voice.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      status.textContent = "Нет доступа к микрофону.";
      return;
    }
    clearVoice();
    const mimeType = pickMimeType();
    voice.chunks = [];
    voice.recorder = new MediaRecorder(voice.stream, mimeType ? { mimeType } : undefined);
    voice.recorder.ondataavailable = (event) => {
      if (event.data.size) voice.chunks.push(event.data);
    };
    voice.recorder.onstop = () => {
      voice.stream?.getTracks().forEach((track) => track.stop());
      voice.stream = null;
      const type = voice.recorder.mimeType || mimeType || "audio/webm";
      voice.blob = new Blob(voice.chunks, { type });
      voice.chunks = [];
      if (!voice.blob.size || voice.durationMs < 600) {
        clearVoice();
        status.textContent = "Слишком коротко — зажми подольше.";
        return;
      }
      showRecording();
      transcribe();
    };
    voice.recorder.start(250);
    voice.recording = true;
    voice.startedAt = Date.now();
    setRecordButton(true);
    status.textContent = "Запись 0:00 — говори, потом жми «Стоп»";
    voice.timer = setInterval(() => {
      const elapsed = Date.now() - voice.startedAt;
      status.textContent = `Запись ${fmtTime(elapsed)} — говори, потом жми «Стоп»`;
      if (elapsed >= MAX_RECORD_MS) stopRecording();
    }, 250);
  };

  for (const target of Object.keys(VOICE_UI)) {
    const ui = VOICE_UI[target];
    $(ui.button).onclick = () => {
      voiceTarget = target;
      if (voice.recording) stopRecording();
      else startRecording();
    };
    $(ui.retry).onclick = () => {
      voiceTarget = target;
      transcribe();
    };
    $(ui.clear).onclick = () => {
      voiceTarget = target;
      clearVoice(target);
    };
    $(ui.audio).addEventListener("timeupdate", (event) => {
      const audio = event.target;
      if (!voice.durationMs) return;
      const total = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : voice.durationMs;
      $(ui.duration).textContent =
        audio.currentTime > 0 && !audio.paused
          ? `${fmtTime(audio.currentTime * 1000)} / ${fmtTime(total)}`
          : fmtTime(total);
    });
  }

  /* ---------- init ---------- */
  (async () => {
    try {
      const { user } = await api("GET", "api/auth/me");
      state.me = user;
    } catch {
      state.me = null;
    }
    if (!state.me) return showAuth();
    if (state.me.mustChangePassword) return showPasswordChange();
    return enterCabinet();
  })();
})();
