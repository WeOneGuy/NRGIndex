// Общий рендер карточки банки: главная и профиль показывают один и тот же диалог.
// Модуль чистый — только HTML-строка; открытие, ссылки и события каждая страница
// вешает сама. Все подстановки экранируются (это проверяет static-scan).
(() => {
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
    );
  const safeColor = (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? value : fallback);
  const wordForm = (value, forms) => {
    const n = Math.abs(value) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 > 1 && n1 < 5) return forms[1];
    if (n1 === 1) return forms[0];
    return forms[2];
  };
  const participantWord = (n) => wordForm(n, ["участник", "участника", "участников"]);
  const tierColors = { S: "#ff5f5a", A: "#f1a653", B: "#e7d471", C: "#8ebd93", D: "#8093b7" };
  const tierColor = (id) => tierColors[id] || "#ff4f79";
  // Адаптивные картинки: srcset/sizes + width/height против сдвигов (CLS).
  const drinkImg = (drink, sizes, eager) => {
    const srcset = drink.imageSrcSet ? ` srcset="${esc(drink.imageSrcSet)}" sizes="${sizes}"` : "";
    const dims = drink.imageWidth ? ` width="${drink.imageWidth}" height="${drink.imageHeight}"` : "";
    return `<img src="${esc(drink.image)}"${srcset}${dims} alt="Банка ${esc(drink.name)}, ${esc(drink.flavor)}" loading="${eager ? "eager" : "lazy"}" decoding="async">`;
  };

  const getDrink = (data, id) => data.drinks.find((item) => item.id === id);
  const getTier = (data, id) => data.tiers.find((tier) => tier.id === id);
  const scoredRatings = (data, drink) =>
    Object.entries(drink.ratings || {}).filter(([, rating]) => rating && getTier(data, rating.tier));
  const averageFor = (data, drink) => {
    const ratings = scoredRatings(data, drink);
    if (!ratings.length) return null;
    const value = ratings.reduce((sum, [, rating]) => sum + getTier(data, rating.tier).score, 0) / ratings.length;
    const rounded = Math.round(value);
    const closest = data.tiers.find((tier) => tier.score === rounded) || data.tiers.at(-1);
    return { tier: closest.id, value, votes: ratings.length };
  };
  const specimenNumber = (data, drink) =>
    String(data.drinks.findIndex((item) => item.id === drink.id) + 1).padStart(3, "0");

  function html({ drink, data, currentUser = null }) {
    if (!drink || !data) return "";
    const average = averageFor(data, drink);
    const votes = scoredRatings(data, drink).length;
    const scoreCopy = average
      ? `${average.value.toFixed(2)} из 5<br>${votes} ${wordForm(votes, ["оценка", "оценки", "оценок"])} учтено`
      : "оценок пока нет";
    const relatedDrinks = (drink.related || []).map((id) => getDrink(data, id)).filter(Boolean);
    const relatedMarkup = relatedDrinks.length
      ? `
      <section class="related-drinks">
        <div class="reviews__head"><h4>Похожие энергосы</h4><span>связанные карточки</span></div>
        <div class="related-drinks__grid">
          ${relatedDrinks
            .map(
              (related) => `
            <button class="related-card" type="button" data-related-drink="${esc(related.id)}" style="--related-a:${safeColor(related.accent?.[0], "#ff4f79")}">
              <span class="related-card__visual">${drinkImg(related, "200px")}</span>
              <span class="related-card__copy"><b>${esc(related.name)}</b><small>${esc(related.flavor)}</small><i>открыть карточку →</i></span>
            </button>
          `,
            )
            .join("")}
        </div>
      </section>
    `
      : "";

    const reviewRow = (person, rating) => {
      const hasReview = Boolean(rating?.review?.trim());
      return `
        <article class="review-row${rating ? "" : " is-untried"}">
          <a class="reviewer" href="profile.html?u=${encodeURIComponent(person.id)}" style="--person-color:${safeColor(person.color, "#9fb7ff")}" aria-label="Открыть профиль ${esc(person.name)}">
            <span class="reviewer__avatar">${person.avatar ? `<img src="${esc(person.avatar)}" alt="">` : esc(person.initials)}</span>
            <span><b>${esc(person.name)}</b><small>${esc(person.role)}</small><i class="reviewer__hint">профиль →</i></span>
          </a>
          <div class="review-tier ${rating ? "" : "is-empty"}">${esc(rating?.tier || "—")}</div>
          <p class="review-text">${hasReview ? `«${esc(rating.review)}»` : rating ? "Подробное мнение пока не записано." : "Ещё не пробовал или не выставил оценку."}</p>
          <span class="review-links">
            <button class="review-link" type="button" data-person-view="${esc(person.id)}">тирлист →</button>
          </span>
        </article>
      `;
    };
    // Оценившие — сверху, не пробовавшие — внизу под своим заголовком.
    const rated = [];
    const untried = [];
    for (const person of data.participants) {
      const rating = drink.ratings?.[person.id];
      (rating ? rated : untried).push({ person, rating });
    }
    const reviews = [
      ...rated.map(({ person, rating }) => reviewRow(person, rating)),
      rated.length && untried.length
        ? `<p class="reviews__subhead">Ещё не пробовали · ${untried.length}</p>`
        : "",
      ...untried.map(({ person, rating }) => reviewRow(person, rating)),
    ].join("");

    // Оценка живёт в кабинете: там полноценный редактор мнения с ИИ-разбором.
    // Кнопка просто уводит в него сразу на нужную банку (?rate=<slug>).
    // Сотрудникам рядом — правка этой же банки в админке (?drink=<slug>).
    const staffEdit =
      currentUser && ["admin", "editor"].includes(currentUser.role)
        ? `<a class="btn btn--ghost" href="/admin?drink=${encodeURIComponent(drink.id)}">✎ Править банку</a>`
        : "";
    const rateButton = `
      <div class="dialog-rate">
        <a class="btn" href="/cabinet.html?rate=${encodeURIComponent(drink.id)}">✦ Оценить банку в кабинете</a>
        ${staffEdit}
        <span class="hint">нейросеть разберёт твоё мнение по словам или голосу</span>
      </div>`;

    return `
      <section class="dialog-hero" style="--dialog-a:${safeColor(drink.accent?.[0], "#ff4f79")}">
        <div class="dialog-product">${drinkImg(drink, "(max-width: 720px) 80vw, 352px", true)}</div>
        <div class="dialog-intro">
          <p class="dialog-kicker">Specimen ${specimenNumber(data, drink)} · ${esc(drink.edition || drink.brand)}</p>
          <h3 id="dialog-title">${esc(drink.name)}</h3>
          <p class="dialog-flavor">${esc(drink.flavor)}</p>
          <div class="dialog-score">
            <b>${esc(average?.tier || "—")}</b>
            <span>${scoreCopy}</span>
          </div>
          <button class="dialog-share" type="button" data-share-drink="${esc(drink.id)}">скопировать ссылку на банку</button>
        </div>
      </section>
      ${rateButton}
      <section class="reviews">
        <div class="reviews__head"><h4>Что сказали</h4><span>${data.participants.length} ${participantWord(data.participants.length)} · личные вердикты</span></div>
        ${reviews}
      </section>
      ${relatedMarkup}
    `;
  }

  const root = typeof window !== "undefined" ? window : globalThis;
  root.NrgDrinkDialog = { html, getDrink, averageFor, scoredRatings, drinkImg, tierColor, esc, safeColor, wordForm, participantWord };
})();
