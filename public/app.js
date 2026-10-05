(() => {
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

  const tierColors = { S: "#ff5f5a", A: "#f1a653", B: "#e7d471", C: "#8ebd93", D: "#8093b7" };
  const tierColor = (id) => tierColors[id] || "#ff4f79";
  // Адаптивные картинки: srcset/sizes + width/height против сдвигов (CLS).
  const drinkImg = (drink, sizes, eager) => {
    const srcset = drink.imageSrcSet ? ` srcset="${esc(drink.imageSrcSet)}" sizes="${sizes}"` : "";
    const dims = drink.imageWidth ? ` width="${drink.imageWidth}" height="${drink.imageHeight}"` : "";
    return `<img src="${esc(drink.image)}"${srcset}${dims} alt="Банка ${esc(drink.name)}, ${esc(drink.flavor)}" loading="${eager ? "eager" : "lazy"}" decoding="async">`;
  };
  const participantWord = (n) => wordForm(n, ["участник", "участника", "участников"]);

  const board = document.querySelector("#tier-board");
  const tabs = document.querySelector("#participant-tabs");
  const boardLabel = document.querySelector("#board-label");
  const boardMeta = document.querySelector("#board-meta");
  const viewDescription = document.querySelector("#view-description");
  const dialog = document.querySelector("#drink-dialog");
  const dialogContent = document.querySelector("#dialog-content");
  const closeButton = document.querySelector(".dialog-close");
  const headerCount = document.querySelector("#header-count");
  const headerPeople = document.querySelector("#header-people");
  const updateNode = document.querySelector("#last-update");
  const aura = document.querySelector(".cursor-aura");
  const rootStyle = document.documentElement.style;
  // Если карточку открыли со страницы профиля, закрытие должно вернуть туда,
  // а не выбросить пользователя на главную (диплинк /d/<slug>?from=profile).
  let returnToProfile = "";

  let data = null;
  let activeView = "average";
  let currentUser = null;

  const getParticipant = (id) => data.participants.find((person) => person.id === id);
  const getDrink = (id) => data.drinks.find((drink) => drink.id === id);
  const getTier = (id) => data.tiers.find((tier) => tier.id === id);

  const scoredRatings = (drink) =>
    Object.entries(drink.ratings || {}).filter(([, rating]) => rating && getTier(rating.tier));

  const averageFor = (drink) => {
    const ratings = scoredRatings(drink);
    if (!ratings.length) return null;
    const value = ratings.reduce((sum, [, rating]) => sum + getTier(rating.tier).score, 0) / ratings.length;
    const rounded = Math.round(value);
    const closest = data.tiers.find((tier) => tier.score === rounded) || data.tiers.at(-1);
    return { tier: closest.id, value, votes: ratings.length };
  };

  const ratingForView = (drink, view) => {
    if (view === "average") return averageFor(drink);
    const rating = drink.ratings?.[view];
    return rating
      ? { ...rating, votes: 1, value: getTier(rating.tier)?.score || 0 }
      : null;
  };

  const createTabs = () => {
    tabs.innerHTML = data.participants
      .map(
        (person, index) => `
      <div class="view-chip-wrap">
        <button class="view-chip" type="button" data-view="${esc(person.id)}">
          <span class="view-chip__number" style="--person-color:${safeColor(person.color, "#9fb7ff")}">${person.avatar ? `<img src="${esc(person.avatar)}" alt="">` : esc(person.initials || String(index + 1).padStart(2, "0"))}</span>
          <span><b>${esc(person.name)}</b><small>${esc(person.role || `участник ${String(index + 1).padStart(2, "0")}`)}</small></span>
        </button>
        <a class="view-chip__profile" href="profile.html?u=${encodeURIComponent(person.id)}" aria-label="Открыть профиль ${esc(person.name)}">профиль →</a>
      </div>
    `,
      )
      .join("");
  };

  const cardTemplate = (drink, rating, index = 0) => {
    const isAverage = activeView === "average";
    // Средний балл показываем всегда с десятой долей: «5.0» — это среднее,
    // а не тир S. Точное значение и число голосов — в подсказке.
    const value = isAverage ? rating.value.toFixed(1) : rating.tier;
    const badgeTitle = isAverage
      ? `Средний балл ${rating.value.toFixed(2)} · ${rating.votes} ${wordForm(rating.votes, ["голос", "голоса", "голосов"])}`
      : `Тир ${rating.tier}`;
    const accent = safeColor(drink.accent?.[0], tierColor(rating.tier));
    const voteText =
      activeView === "average"
        ? `${rating.votes} ${wordForm(rating.votes, ["голос", "голоса", "голосов"])}`
        : getParticipant(activeView)?.name || "оценка";

    return `
      <button class="drink-card" type="button" data-drink="${esc(drink.id)}" style="--card-accent:${accent};--i:${index}" aria-label="Открыть карточку ${esc(drink.name)}">
        <span class="drink-card__visual">
          <span class="drink-card__votes">${esc(voteText)}</span>
          <span class="drink-card__rank${isAverage ? " is-num" : ""}" title="${esc(badgeTitle)}">${esc(isAverage ? value : rating.tier)}</span>
          ${drinkImg(drink, "(max-width: 720px) 45vw, 240px")}
        </span>
        <span class="drink-card__copy">
          <b>${esc(drink.name)}</b>
          <span>${esc(drink.flavor)}</span>
        </span>
      </button>
    `;
  };

  let renderTimer = null;
  let searchQuery = "";
  let tierFilter = "all";
  const matchesSearch = (drink) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return [drink.brand, drink.name, drink.flavor, drink.edition]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  };
  const isFiltering = () => searchQuery.trim() !== "" || tierFilter !== "all";
  const renderBoard = () => {
    if (!data) return;
    window.clearTimeout(renderTimer);
    board.classList.add("is-changing");

    renderTimer = window.setTimeout(() => {
      const rows = data.tiers
        .map((tier, rowIndex) => {
          const drinks = data.drinks
            .map((drink) => ({ drink, rating: ratingForView(drink, activeView) }))
            .filter((entry) => entry.rating?.tier === tier.id)
            .filter((entry) => (tierFilter === "all" || entry.rating.tier === tierFilter) && matchesSearch(entry.drink))
            .sort((a, b) => {
              const scoreDifference = (b.rating.value || 0) - (a.rating.value || 0);
              if (scoreDifference) return scoreDifference;
              const aOrder = a.rating.order ?? Number.POSITIVE_INFINITY;
              const bOrder = b.rating.order ?? Number.POSITIVE_INFINITY;
              if (aOrder !== bOrder) return aOrder - bOrder;
              return data.drinks.indexOf(a.drink) - data.drinks.indexOf(b.drink);
            });

          return `
          <div class="tier-row" style="--tier-color:${tierColor(tier.id)};--row:${rowIndex}">
            <div class="tier-label">
              <span class="tier-letter">${esc(tier.id)}</span>
              <span class="tier-label__copy"><b>${esc(tier.title)}</b><span>${esc(tier.note)}</span></span>
            </div>
            <div class="tier-items">
              ${drinks.length ? drinks.map(({ drink, rating }, index) => cardTemplate(drink, rating, index)).join("") : `<div class="empty-tier">${isFiltering() ? "ничего не найдено — ослабьте фильтры" : "пока пусто"}</div>`}
            </div>
          </div>
        `;
        })
        .join("");

      board.innerHTML = rows;
      attachCards();
      board.classList.remove("is-changing");
    }, 170);

    document.querySelectorAll(".view-chip[data-view]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.view === activeView);
    });

    if (activeView === "average") {
      const votes = data.drinks.reduce((sum, drink) => sum + scoredRatings(drink).length, 0);
      boardLabel.textContent = "NRG / CONSENSUS";
      boardMeta.textContent = `${votes} из ${data.drinks.length * data.participants.length} голосов учтено`;
      viewDescription.textContent =
        "Сводный тир считается по всем выставленным оценкам. Пока голос один — вердикт особенно безапелляционный.";
      document.querySelector("#rating-title").textContent = "Общий стол";
    } else {
      const person = getParticipant(activeView);
      const count = data.drinks.filter((drink) => drink.ratings?.[activeView]).length;
      boardLabel.textContent = `NRG / ${String(person?.name || "").toUpperCase()}`;
      boardMeta.textContent = `${count} ${wordForm(count, ["оценка", "оценки", "оценок"])} из ${data.drinks.length}`;
      viewDescription.textContent = count
        ? `Личный тирлист участника «${person?.name || ""}». Здесь чужие голоса ни на что не влияют.`
        : `У ${person?.name || "участника"} пока нет выставленных оценок. Места уже накрыты — осталось начать дегустацию.`;
      document.querySelector("#rating-title").textContent = `Стол: ${person?.name || ""}`;
    }
    if (isFiltering()) {
      const shown = data.drinks.filter((drink) => {
        const rating = ratingForView(drink, activeView);
        return rating && (tierFilter === "all" || rating.tier === tierFilter) && matchesSearch(drink);
      }).length;
      boardMeta.textContent = `найдено: ${shown} ${wordForm(shown, ["банка", "банки", "банок"])}`;
    }
  };

  const attachCards = () => {
    // Без 3D-наклона за курсором: поворот карточки заставлял мелкий текст
    // бейджей тира/оценки перерисовываться каждый кадр — мерцание. Hover живой
    // за счёт подъёма банки (.drink-card:hover img), бейджи стоят мёртво.
    document.querySelectorAll(".drink-card").forEach((card) => {
      card.addEventListener("click", () => openDrink(card.dataset.drink));
    });
  };

  /* ---------- витрина: главный энергос ---------- */
  // В витрину попадают только банки S-тира по общему столу: это «главные».
  // Топ-3 из них мягко листаются, чтобы шапка не застывала.
  const SPECIMEN_ROTATE_MS = 7000;
  const specimen = { items: [], index: 0, timer: null };

  const specimenCandidates = () =>
    data.drinks
      .map((drink) => ({ drink, average: averageFor(drink) }))
      .filter((item) => item.average && item.average.tier === "S")
      .sort(
        (a, b) =>
          b.average.value - a.average.value ||
          b.average.votes - a.average.votes ||
          a.drink.id.localeCompare(b.drink.id),
      )
      .slice(0, 3);

  const applySpecimen = () => {
    const card = document.getElementById("hero-specimen");
    if (!card) return;
    const item = specimen.items[specimen.index];
    card.classList.toggle("is-empty", !item);
    if (!item) {
      // Пустая витрина — возвращаем базовые цвета ауры и «разложенной».
      rootStyle.setProperty("--can-a", "#ff4f79");
      rootStyle.setProperty("--can-b", "#ff7448");
      const caption = document.getElementById("specimen-caption");
      if (caption) caption.innerHTML = `ПОКА НЕТ S<br><span>оцени банку на S — попадёт сюда</span>`;
      return;
    }
    const { drink, average } = item;

    // Цвета этой банки — и для ореола карточки, и для всей страницы: аура курсора
    // и слово «разложенная» перетекают к ним той же анимацией, что и влёт банки.
    const accentA = safeColor(drink.accent?.[0], "#ff4f79");
    const accentB = safeColor(drink.accent?.[1], "#ff7448");
    card.style.setProperty("--hero-a", accentA);
    card.style.setProperty("--hero-b", accentB);
    rootStyle.setProperty("--can-a", accentA);
    rootStyle.setProperty("--can-b", accentB);

    const image = document.getElementById("specimen-image");
    if (image) {
      image.fetchPriority = "high";
      image.srcset = drink.imageSrcSet || "";
      image.sizes = "(max-width: 720px) 70vw, 25rem";
      if (drink.imageWidth) {
        image.width = drink.imageWidth;
        image.height = drink.imageHeight;
      }
      image.src = drink.image;
      image.alt = `Банка ${drink.name}, ${drink.flavor}`;
      image.hidden = false;
    }

    const stamp = document.getElementById("specimen-stamp");
    if (stamp) {
      stamp.textContent = average.tier;
      stamp.style.background = tierColor(average.tier);
    }

    const caption = document.getElementById("specimen-caption");
    if (caption) {
      caption.innerHTML = `${esc(String(drink.name || "").toUpperCase())}<br><span>${esc(
        String(drink.flavor || "").toUpperCase(),
      )}</span>`;
    }
  };

  const SPECIMEN_SWAP_OUT_MS = 360;
  const SPECIMEN_SWAP_IN_MS = 1100;
  const rotateSpecimen = () => {
    if (specimen.items.length < 2 || document.visibilityState !== "visible") return;
    const card = document.getElementById("hero-specimen");
    if (!card || card.classList.contains("is-swapping")) return;
    card.classList.add("is-swapping");
    window.setTimeout(() => {
      specimen.index = (specimen.index + 1) % specimen.items.length;
      applySpecimen();
      card.classList.remove("is-swapping");
      // перезапускаем keyframes «входа»: снять класс, форс reflow, навесить заново
      card.classList.remove("is-entering");
      void card.offsetWidth;
      card.classList.add("is-entering");
      window.setTimeout(() => card.classList.remove("is-entering"), SPECIMEN_SWAP_IN_MS);
    }, SPECIMEN_SWAP_OUT_MS);
  };

  const setupSpecimen = () => {
    specimen.items = specimenCandidates();
    specimen.index = 0;
    applySpecimen();
    // Витрина определилась: показываем ауру (она уже в цвете банки) и даём
    // «разложенной» окраситься — до этого момента страница нейтральная.
    document.documentElement.classList.add("can-ready");
    if (specimen.timer) window.clearInterval(specimen.timer);
    specimen.timer = null;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (specimen.items.length > 1 && !reduceMotion) {
      specimen.timer = window.setInterval(rotateSpecimen, SPECIMEN_ROTATE_MS);
    }
  };

  const openDrink = (drinkId, { returnTo = "" } = {}) => {
    const drink = getDrink(drinkId);
    if (!drink) return;
    if (returnTo) returnToProfile = returnTo;
    // Шаблон общий с профилем (public/drink-dialog.js) — карточка везде одинаковая.
    dialogContent.innerHTML = window.NrgDrinkDialog.html({ drink, data, currentUser });

    dialogContent.querySelectorAll("[data-related-drink]").forEach((button) => {
      button.addEventListener("click", () => openDrink(button.dataset.relatedDrink));
    });

    dialogContent.querySelectorAll("[data-person-view]").forEach((button) => {
      button.addEventListener("click", () => {
        activeView = button.dataset.personView;
        renderBoard();
        dialog.close();
        document.querySelector("#rating").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });

    dialogContent.querySelector("[data-share-drink]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      const url = `${location.origin}/d/${encodeURIComponent(button.dataset.shareDrink)}`;
      try {
        await navigator.clipboard.writeText(url);
        const original = button.textContent;
        button.textContent = "ссылка готова ✓";
        window.setTimeout(() => {
          button.textContent = original;
        }, 1500);
      } catch {
        button.textContent = "не вышло — ссылка в адресной строке";
      }
    });

    // Повторное showModal() на открытом диалоге бросает InvalidStateError —
    // переход по «похожей» банке просто перерисовывает содержимое.
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("is-dialog-open");
    // диплинк: открытая карточка живёт на /d/<slug> — можно кидать в чат
    history.replaceState(null, "", `/d/${encodeURIComponent(drink.id)}`);
  };

  const closeDialog = () => {
    if (dialog.open) dialog.close();
  };

  const refreshChrome = () => {
    createTabs();
    headerCount.innerHTML = `<span data-count="${Number(data.drinks.length)}">0</span> ${wordForm(data.drinks.length, ["образец", "образца", "образцов"])}`;
    headerPeople.innerHTML = `<span data-count="${Number(data.participants.length)}">0</span> ${participantWord(data.participants.length)}`;
    const heroPeople = document.querySelector("#hero-people");
    if (heroPeople && data.participants.length) {
      const n = data.participants.length;
      heroPeople.textContent = `${n} ${participantWord(n)}. Один общий рейтинг. Никакой объективности — только вкус, настроение и последствия.`;
    }
    updateNode.textContent = data.updatedAt;
    window.nrgCountUp?.();
  };

  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (!viewButton) return;
    activeView = viewButton.dataset.view;
    renderBoard();
    if (viewButton.classList.contains("brand")) {
      document.querySelector("#rating").scrollIntoView({ behavior: "smooth" });
    }
  });

  closeButton.addEventListener("click", closeDialog);
  const searchInput = document.getElementById("board-search");
  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value;
    renderBoard();
  });
  document.getElementById("board-filters")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tier-filter]");
    if (!button) return;
    tierFilter = button.dataset.tierFilter;
    document
      .querySelectorAll("[data-tier-filter]")
      .forEach((chip) => chip.classList.toggle("is-active", chip === button));
    renderBoard();
  });
  // Закрытие только по клику в backdrop: у клавиатурного Enter/Space clientX/Y = 0,
  // и проверка координат ошибочно закрывала карточку.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener("close", () => {
    document.body.classList.remove("is-dialog-open");
    if (!location.pathname.startsWith("/d/")) return;
    if (returnToProfile) {
      // Карточку открывали со страницы профиля — закрытие возвращает туда,
      // а не выбрасывает на главную.
      const back = returnToProfile;
      returnToProfile = "";
      location.href = back;
      return;
    }
    history.replaceState(null, "", "/");
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll(".reveal").forEach((element, index) => {
    element.style.transitionDelay = `${Math.min(index % 4, 3) * 70}ms`;
    observer.observe(element);
  });

  window.addEventListener("pointermove", (event) => {
    if (!aura || window.matchMedia("(pointer: coarse)").matches) return;
    aura.animate(
      { left: `${event.clientX}px`, top: `${event.clientY}px` },
      { duration: 900, fill: "forwards", easing: "cubic-bezier(.22,1,.36,1)" },
    );
  });

  const marqueeTrack = document.querySelector(".marquee__track");
  let marqueeResizeTimer = null;
  const setupMarquee = () => {
    if (!marqueeTrack) return;
    const original = marqueeTrack.dataset.original || marqueeTrack.innerHTML;
    marqueeTrack.dataset.original = original;
    marqueeTrack.innerHTML = original;
    let copies = 1;
    while (marqueeTrack.scrollWidth < window.innerWidth * 2 && copies < 20) {
      marqueeTrack.innerHTML += original;
      copies += 1;
    }
    if (copies % 2 === 1) marqueeTrack.innerHTML += original;
  };
  window.addEventListener("resize", () => {
    window.clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = window.setTimeout(setupMarquee, 250);
  });
  setupMarquee();

  // Шрифты догружаются после первого замера — иначе на конце трека остаётся пустота.
  if (document.fonts?.ready) document.fonts.ready.then(setupMarquee);

  // Рулетка «Что выпить сегодня?»: лента банок крутится и тормозит на случайной.
  const reel = document.querySelector("#roulette-reel");
  const spinButton = document.querySelector("#roulette-spin");
  const rollResult = document.querySelector("#roulette-result");
  const untriedButton = document.querySelector("#roll-untried");
  const rollTiers = new Set(["S", "A"]);
  let untriedOnly = false;
  let spinning = false;

  const rollPool = () =>
    data.drinks.filter((drink) => {
      const avg = averageFor(drink);
      if (!avg || !rollTiers.has(avg.tier)) return false;
      return !untriedOnly || !drink.ratings?.[currentUser?.username];
    });
  const reelItem = (drink) => {
    const tier = averageFor(drink).tier;
    return `<span class="roulette__item" style="--card-accent:${safeColor(drink.accent?.[0], tierColor(tier))}">
      <b style="color:${tierColor(tier)}">${esc(tier)}</b>${drinkImg(drink, "8rem")}<small>${esc(drink.name)}</small>
    </span>`;
  };
  const drum = window.NrgRoulette.create(reel, reelItem);
  const resetReel = () => {
    const pool = rollPool();
    if (!pool.length) {
      reel.innerHTML = "";
      rollResult.textContent = "под такие фильтры банок нет — ослабьте их";
      spinButton.disabled = true;
      return;
    }
    drum.reset(pool);
    rollResult.textContent = `в барабане: ${pool.length}`;
    spinButton.disabled = false;
  };
  const spin = async () => {
    const pool = rollPool();
    if (spinning || !pool.length) return;
    spinning = true;
    spinButton.disabled = true;
    rollResult.textContent = "крутим…";
    const winner = await drum.spin({
      pool,
      onWinner: (drink) => {
        rollResult.innerHTML = `сегодня: <button type="button" class="roulette__open" data-drink="${esc(drink.id)}">${esc(drink.brand)} ${esc(drink.name)}${drink.flavor ? ` — ${esc(drink.flavor)}` : ""} →</button>`;
      },
    });
    if (winner) spinButton.textContent = "Ещё раз";
    spinning = false;
    spinButton.disabled = false;
  };
  const setupRoulette = () => {
    if (!reel) return;
    if (currentUser) untriedButton.hidden = false;
    document.querySelectorAll("[data-roll-tier]").forEach((button) => {
      button.addEventListener("click", () => {
        if (spinning) return;
        const tier = button.dataset.rollTier;
        if (rollTiers.has(tier)) rollTiers.delete(tier);
        else rollTiers.add(tier);
        button.classList.toggle("is-active", rollTiers.has(tier));
        button.setAttribute("aria-pressed", String(rollTiers.has(tier)));
        resetReel();
      });
    });
    untriedButton.addEventListener("click", () => {
      if (spinning) return;
      untriedOnly = !untriedOnly;
      untriedButton.classList.toggle("is-active", untriedOnly);
      untriedButton.setAttribute("aria-pressed", String(untriedOnly));
      resetReel();
    });
    spinButton.addEventListener("click", spin);
    rollResult.addEventListener("click", (event) => {
      const id = event.target.closest("[data-drink]")?.dataset.drink;
      if (id) openDrink(id);
    });
    resetReel();
  };

  (async () => {
    // Роль нужна только чтобы показать сотрудникам кнопку правки банки в админке.
    try {
      const meRes = await fetch("api/auth/me", { headers: { accept: "application/json" } });
      currentUser = (await meRes.json()).user || null;
    } catch {
      currentUser = null;
    }
    try {
      const res = await fetch("api/public/summary", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (error) {
      board.innerHTML = `<div class="empty-tier">Не удалось загрузить данные: ${esc(error.message)}</div>`;
      return;
    }
    if (data.site?.title) document.title = `${data.site.title} — тирлист энергетиков`;
    const brandName = document.querySelector(".brand__name");
    if (brandName && data.site?.title && data.site.title !== "NRG / INDEX") {
      brandName.textContent = data.site.title;
    }
    const meta = document.querySelector('meta[name="description"]');
    if (meta && data.site?.description) meta.setAttribute("content", data.site.description);
    refreshChrome();
    // диплинки: ?view=<username> — чей тирлист, /d/<slug> или ?drink=<slug> — сразу открыть карточку
    const params = new URLSearchParams(location.search);
    const view = params.get("view");
    if (view && getParticipant(view)) activeView = view;
    renderBoard();
    setupSpecimen();
    setupRoulette();
    const pathDrink = location.pathname.match(/^\/d\/([^/]+?)\/?$/)?.[1];
    const drinkParam = (pathDrink ? decodeURIComponent(pathDrink) : params.get("drink")) || "";
    if (drinkParam && getDrink(drinkParam)) {
      history.replaceState(null, "", location.pathname + location.hash);
      // Из профиля карточки приходят с ?from=profile&u=<ник>: запоминаем, куда вернуть.
      const fromProfile =
        params.get("from") === "profile"
          ? params.get("u")
            ? `/profile.html?u=${encodeURIComponent(params.get("u"))}`
            : "/profile.html"
          : "";
      openDrink(drinkParam, { returnTo: fromProfile });
    }
  })();
})();
