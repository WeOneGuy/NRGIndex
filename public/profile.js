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
  const tierColors = { S: "#ff5f5a", A: "#f1a653", B: "#e7d471", C: "#8ebd93", D: "#8093b7" };
  const tierColor = (id) => tierColors[id] || "#ff4f79";
  const ratingImg = (rating) => {
    const srcset = rating.imageSrcSet ? ` srcset="${esc(rating.imageSrcSet)}" sizes="(max-width: 720px) 45vw, 240px"` : "";
    const dims = rating.imageWidth ? ` width="${rating.imageWidth}" height="${rating.imageHeight}"` : "";
    return `<img src="${esc(imgSrc(rating.image))}"${srcset}${dims} alt="Банка ${esc(rating.name)}" loading="lazy" decoding="async">`;
  };
  // картинки из БД бывают относительными (assets/...) — страница может жить не в корне
  const imgSrc = (src) => (/^(\/|https?:|data:)/.test(src || "") ? src : `/${src || "assets/favicon.svg"}`);

  const getJson = async (url) => {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  };

  const username = new URLSearchParams(location.search).get("u") || "";
  // Ссылки на карточки банок остаются фолбэком без JS (ведут на главную и
  // возвращают сюда). С включённым JS диалог открывается прямо в профиле.
  let profileUserId = username;
  let summaryData = null;
  let currentUser = null;
  const drinkLink = (slug) =>
    `/d/${encodeURIComponent(slug)}?from=profile&u=${encodeURIComponent(profileUserId || "")}`;
  const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  // «сегодня / вчера / N дней назад» — мягкие подписи для активности
  const parseDbTime = (value) => Date.parse(String(value || "").replace(" ", "T") + "Z") || 0;
  const timeAgoSoft = (value) => {
    const ts = parseDbTime(value);
    if (!ts) return "";
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return "сегодня";
    if (days === 1) return "вчера";
    if (days < 30) return `${days} ${wordForm(days, ["день", "дня", "дней"])} назад`;
    const months = Math.round(days / 30);
    return `${months} ${wordForm(months, ["месяц", "месяца", "месяцев"])} назад`;
  };

  const renderPeople = (participants, active) => {
    $("profile-people").innerHTML = participants
      .map(
        (person) => `
        <a class="view-chip ${person.id === active ? "is-active" : ""}" href="/profile.html?u=${encodeURIComponent(person.id)}">
          <span class="view-chip__number" style="--person-color:${safeColor(person.color, "#9fb7ff")}">${person.avatar ? `<img src="${esc(imgSrc(person.avatar))}" alt="">` : esc(person.initials)}</span>
          <span><b>${esc(person.name)}</b><small>${esc(person.role || "участник")}</small></span>
        </a>`,
      )
      .join("");
  };

  const renderHero = ({ profile, stats, tiers }) => {
    const color = safeColor(profile.color, "#9fb7ff");
    const max = Math.max(1, ...Object.values(stats.distribution));
    const bars = tiers
      .map((tier, index) => {
        const n = stats.distribution[tier.id] || 0;
        return `
        <div class="dist-bar" style="--tier-color:${tierColor(tier.id)};--i:${index}">
          <span class="dist-bar__count">${n}</span>
          <span class="dist-bar__fill" style="--h:${Math.round((n / max) * 100)}%"></span>
          <b>${esc(tier.id)}</b>
        </div>`;
      })
      .join("");
    const avgTier = stats.average
      ? tiers.reduce((best, tier) =>
          Math.abs(tier.score - stats.average) < Math.abs(best.score - stats.average) ? tier : best,
        )
      : null;
    const agreementCopy =
      stats.agreement === null
        ? "не с кем сравнить"
        : stats.agreement >= 80
          ? "почти всегда как все"
          : stats.agreement >= 60
            ? "в целом согласен со столом"
            : "идёт против стола";

    // Мягкая активность: сетка дней за 15 недель и пара живых инсайтов.
    const activity = stats.activity || {
      heatmap: [],
      streak: 0,
      streakAlive: false,
      bestWeekday: null,
      topMonth: null,
      last30: 0,
      lastAt: null,
    };
    const WEEKDAY_GENITIVE = [
      "воскресеньям",
      "понедельникам",
      "вторникам",
      "средам",
      "четвергам",
      "пятницам",
      "субботам",
    ];
    const dayMap = new Map((activity.heatmap || []).map((day) => [day.date, day]));
    const weeks = 15;
    const today = new Date();
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const firstWeek = new Date(end);
    firstWeek.setUTCDate(firstWeek.getUTCDate() - ((firstWeek.getUTCDay() + 6) % 7) - (weeks - 1) * 7);
    const columns = [];
    const monthCells = [];
    let lastMonth = -1;
    let totalActions = 0;
    for (let w = 0; w < weeks; w++) {
      const monday = new Date(firstWeek);
      monday.setUTCDate(monday.getUTCDate() + w * 7);
      if (monday.getUTCMonth() !== lastMonth) {
        monthCells.push(`<span>${MONTHS_SHORT[monday.getUTCMonth()]}</span>`);
        lastMonth = monday.getUTCMonth();
      } else {
        monthCells.push(`<span></span>`);
      }
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(firstWeek);
        date.setUTCDate(date.getUTCDate() + w * 7 + d);
        if (date > end) {
          cells.push(`<span class="heat-cell is-future"></span>`);
          continue;
        }
        const key = date.toISOString().slice(0, 10);
        const entry = dayMap.get(key);
        const count = entry ? entry.ratings + entry.added : 0;
        totalActions += count;
        const parts = [];
        if (entry?.ratings) parts.push(`${entry.ratings} ${wordForm(entry.ratings, ["оценка", "оценки", "оценок"])}`);
        if (entry?.added) parts.push(`${entry.added} ${wordForm(entry.added, ["банка", "банки", "банок"])}`);
        const tip = `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}: ${parts.join(", ") || "тихо"}`;
        const heat = count ? Math.min(1, 0.3 + count * 0.23) : 0;
        cells.push(
          `<span class="heat-cell${count ? "" : " is-empty"}" style="--heat:${Number(heat.toFixed(2))}" title="${esc(tip)}"></span>`,
        );
      }
      columns.push(`<span class="heat-col">${cells.join("")}</span>`);
    }
    const chips = [];
    if (activity.streak > 1) {
      chips.push(
        `<span class="activity-chip"><b>серия ${activity.streak} ${wordForm(activity.streak, ["день", "дня", "дней"])}</b> подряд${activity.streakAlive ? "" : " — самое время вернуться"}</span>`,
      );
    } else if (activity.streak === 1 && activity.streakAlive) {
      chips.push(`<span class="activity-chip"><b>серия 1 день</b> — начало положено</span>`);
    } else if (activity.lastAt) {
      chips.push(`<span class="activity-chip">последняя — <b>${timeAgoSoft(activity.lastAt)}</b></span>`);
    }
    if (activity.bestWeekday !== null && (activity.heatmap || []).length > 2) {
      chips.push(`<span class="activity-chip">чаще всего — по <b>${WEEKDAY_GENITIVE[activity.bestWeekday]}</b></span>`);
    }
    if (activity.topMonth && activity.topMonth.count >= 2) {
      chips.push(
        `<span class="activity-chip">самый щедрый месяц — <b>${activity.topMonth.label}</b> · ${activity.topMonth.count} ${wordForm(activity.topMonth.count, ["действие", "действия", "действий"])}</span>`,
      );
    }
    if (activity.last30) {
      chips.push(`<span class="activity-chip">за месяц — <b>${activity.last30}</b></span>`);
    }
    if (!chips.length) chips.push(`<span class="activity-chip">пока тихо — оцените первую банку</span>`);
    const activityMarkup = `
      <div class="profile-activity">
        <div class="profile-activity__head">
          <p class="eyebrow">Активность</p>
          <span class="profile-activity__meta">${
            totalActions
              ? `за 15 недель: ${totalActions} ${wordForm(totalActions, ["действие", "действия", "действий"])}`
              : "за 15 недель — тихо"
          }</span>
        </div>
        <div class="activity-heat" role="img" aria-label="Активность по дням за 15 недель">
          <div class="activity-heat__months" aria-hidden="true">${monthCells.join("")}</div>
          <div class="activity-heat__row">
            <div class="activity-heat__weekdays" aria-hidden="true"><span>пн</span><span></span><span>ср</span><span></span><span>пт</span><span></span><span>вс</span></div>
            <div class="activity-heat__weeks">${columns.join("")}</div>
          </div>
        </div>
        <div class="activity-insights">
          ${chips.slice(0, 3).join("")}
          <span class="activity-legend">меньше <i class="heat-cell is-empty"></i><i class="heat-cell" style="--heat:.55"></i><i class="heat-cell" style="--heat:1"></i> больше</span>
        </div>
      </div>`;

    $("profile-hero").innerHTML = `
      <div class="profile-id" style="--person-color:${color}">
        <span class="profile-avatar">${profile.avatar ? `<img src="${esc(imgSrc(profile.avatar))}" alt="">` : esc(profile.initials)}</span>
        <div>
          <p class="eyebrow">Участник${profile.since ? ` · с ${esc(profile.since)}` : ""}</p>
          <h1>${esc(profile.name)}</h1>
          <p class="profile-role">${esc(profile.role || "дегустатор без титула")}</p>
        </div>
      </div>
      <div class="profile-stats">
        <div><b data-count="${Number(stats.ratings)}">0</b><span>${wordForm(stats.ratings, ["оценка", "оценки", "оценок"])}</span></div>
        <div><b data-count="${Number(stats.reviews)}">0</b><span>${wordForm(stats.reviews, ["отзыв", "отзыва", "отзывов"])}</span></div>
        <div><b data-count="${Number(stats.added)}">0</b><span>${wordForm(stats.added, ["банку добавил", "банки добавил", "банок добавил"])}</span></div>
        <div><b>${avgTier ? esc(avgTier.id) : "—"}</b><span>${stats.average ? `средний тир · ${String(Math.round(stats.average * 100) / 100).replace(".", ",")}` : "средний тир"}</span></div>
        <div><b>${stats.agreement === null ? "—" : `${stats.agreement}%`}</b><span>${agreementCopy}</span></div>
      </div>
      <div class="profile-dist" aria-label="Распределение по тирам">${bars}</div>
      ${activityMarkup}
    `;
    // столбики растут из нуля: целевая высота уже в --h, ставим её после отрисовки
    $("profile-hero")
      .querySelectorAll(".dist-bar__fill")
      .forEach((fill) => {
        void fill.offsetHeight;
        fill.style.height = fill.style.getPropertyValue("--h");
      });
    window.nrgCountUp?.($("profile-hero"));
  };

  /* ---------- карточка банки: открываем диалог прямо в профиле ---------- */
  // Никаких переходов на главную: тот же диалог, что и там (public/drink-dialog.js),
  // поэтому ничего не мелькает и открывается мгновенно.
  const closeDrinkDialog = () => {
    const dialog = $("drink-dialog");
    if (dialog?.open) dialog.close();
  };

  const openDrinkDialog = (slug) => {
    const dialog = $("drink-dialog");
    const content = $("dialog-content");
    const drink = summaryData?.drinks?.find((item) => item.id === slug);
    if (!dialog || !content || !drink || !window.NrgDrinkDialog) return;
    content.innerHTML = window.NrgDrinkDialog.html({ drink, data: summaryData, currentUser });
    content.querySelectorAll("[data-related-drink]").forEach((button) => {
      button.addEventListener("click", () => openDrinkDialog(button.dataset.relatedDrink));
    });
    content.querySelectorAll("[data-person-view]").forEach((button) => {
      button.addEventListener("click", () => {
        location.href = `/profile.html?u=${encodeURIComponent(button.dataset.personView)}`;
      });
    });
    content.querySelector("[data-share-drink]")?.addEventListener("click", async (event) => {
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
    if (!dialog.open) dialog.showModal();
    document.body.classList.add("is-dialog-open");
  };

  document.querySelector(".dialog-close")?.addEventListener("click", closeDrinkDialog);
  const profileDialog = document.querySelector("#drink-dialog");
  profileDialog?.addEventListener("click", (event) => {
    if (event.target === profileDialog) closeDrinkDialog();
  });
  profileDialog?.addEventListener("close", () => document.body.classList.remove("is-dialog-open"));
  // Ссылка остаётся фолбэком для браузеров без JS, с JS — открываем диалог здесь.
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-drink]");
    if (!link) return;
    event.preventDefault();
    openDrinkDialog(link.dataset.drink);
  });

  const cardTemplate = (rating, index = 0) => `
    <a class="drink-card" data-drink="${esc(rating.drink)}" href="${esc(drinkLink(rating.drink))}" style="--card-accent:${safeColor(rating.accent?.[0], tierColor(rating.tier))};--i:${index}">
      <span class="drink-card__visual">
        ${rating.othersAvg !== null ? `<span class="drink-card__votes">стол: ${String(rating.othersAvg).replace(".", ",")}</span>` : ""}
        <span class="drink-card__rank">${esc(rating.tier)}</span>
        ${ratingImg(rating)}
      </span>
      <span class="drink-card__copy">
        <b>${esc(rating.name)}</b>
        <span>${esc(rating.flavor)}</span>
      </span>
    </a>`;

  const renderBoard = ({ tiers, ratings }) => {
    $("profile-board-block").hidden = false;
    $("profile-board-meta").textContent = `${ratings.length} ${wordForm(ratings.length, ["банка", "банки", "банок"])}`;
    $("profile-board").innerHTML = tiers
      .map((tier, rowIndex) => {
        const items = ratings.filter((rating) => rating.tier === tier.id);
        return `
        <div class="tier-row" style="--tier-color:${tierColor(tier.id)};--row:${rowIndex}">
          <div class="tier-label">
            <span class="tier-letter">${esc(tier.id)}</span>
            <span class="tier-label__copy"><b>${esc(tier.title)}</b><span>${esc(tier.note)}</span></span>
          </div>
          <div class="tier-items">
            ${items.length ? items.map((rating, index) => cardTemplate(rating, index)).join("") : `<div class="empty-tier">пока пусто</div>`}
          </div>
        </div>`;
      })
      .join("");
  };

  const renderReviews = ({ ratings }) => {
    const withText = ratings.filter((rating) => rating.review.trim());
    $("profile-reviews-block").hidden = false;
    $("profile-reviews-meta").textContent = withText.length ? "свежие сверху" : "";
    $("profile-reviews").innerHTML = withText.length
      ? withText
          .map((rating, index) => {
            const diff = rating.othersAvg === null ? null : Math.round(({ S: 5, A: 4, B: 3, C: 2, D: 1 }[rating.tier] || 0) - rating.othersAvg);
            const verdict =
              diff === null ? "" : diff >= 1 ? "выше стола" : diff <= -1 ? "ниже стола" : "как у стола";
            return `
            <article class="profile-review" style="--i:${index}">
              <img src="${esc(imgSrc(rating.image))}" alt="" loading="lazy">
              <div>
                <b>${esc(rating.name)}</b>
                <small>${esc([rating.flavor, rating.updatedAt].filter(Boolean).join(" · "))}</small>
                <p>«${esc(rating.review)}»</p>
              </div>
              <div class="profile-review__tier" style="--tier-color:${tierColor(rating.tier)}">
                <b>${esc(rating.tier)}</b>${verdict ? `<small>${verdict}</small>` : ""}
              </div>
            </article>`;
          })
          .join("")
      : `<p class="hint">Словами пока ничего не сказал — только тиры.</p>`;
  };

  const renderHistory = ({ history }) => {
    const block = $("profile-history-block");
    if (!block) return;
    if (!history?.length) {
      block.hidden = true;
      return;
    }
    block.hidden = false;
    $("profile-history-meta").textContent = `${history.length} ${wordForm(history.length, ["событие", "события", "событий"])}`;
    $("profile-history").innerHTML = history
      .map((item) => {
        const link = item.slug
          ? `<a data-drink="${esc(item.slug)}" href="${esc(drinkLink(item.slug))}">карточка →</a>`
          : "";
        return `
        <div class="history-row">
          <time datetime="${esc(String(item.at || "").replace(" ", "T"))}Z">${esc(formatWhen(item.at))}</time>
          <p>${esc(item.summary || "изменение")}</p>
          ${link}
        </div>`;
      })
      .join("");
  };

  const formatWhen = (value) => {
    const date = new Date(String(value || "").replace(" ", "T") + "Z");
    if (Number.isNaN(date.getTime())) return String(value || "");
    return date.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  (async () => {
    let summary = null;
    try {
      summary = await getJson("/api/public/summary");
    } catch {
      /* без списка участников профиль всё равно покажем */
    }
    summaryData = summary;
    // Роль — только чтобы в карточке показать кнопку правки для сотрудников.
    getJson("/api/auth/me")
      .then((me) => {
        currentUser = me?.user || null;
      })
      .catch(() => {});
    const target = username || summary?.participants?.[0]?.id;
    profileUserId = target || "";
    renderPeople(summary?.participants || [], target);
    if (!target) {
      $("profile-hero").innerHTML = `<p class="hint">Участников пока нет.</p>`;
      return;
    }
    if (!username) history.replaceState(null, "", `/profile.html?u=${encodeURIComponent(target)}`);
    try {
      const data = await getJson(`/api/public/profile/${encodeURIComponent(target)}`);
      const title = summary?.site?.title || "NRG / INDEX";
      document.title = `${data.profile.name} — ${title}`;
      renderHero(data);
      renderBoard(data);
      renderReviews(data);
      renderHistory(data);
    } catch (error) {
      $("profile-hero").innerHTML = `
        <p class="eyebrow">404</p>
        <h1 class="profile-missing">Профиль не найден</h1>
        <p class="hint">${esc(error.message)}. Возможно, участник скрыт или ссылка устарела.</p>`;
    }
  })();
})();
