// Условное логирование в зависимости от окружения
const isDev = true; // Установлено true для отладки; в продакшене можно установить false
const log = (...args) => isDev && console.log(...args);
const logError = (...args) => console.error(...args);

// Основной обработчик загрузки страницы
document.addEventListener("DOMContentLoaded", async () => {
  // Элементы DOM
  const eventsList = document.getElementById("eventsList");
  const searchInput = document.getElementById("search");
  const dateFilter = document.getElementById("dateFilter");
  const paymentModal = document.getElementById("paymentModal");
  const paymentForm = document.getElementById("paymentForm");
  const createEventButton = document.querySelector(".create-event");
  const createEventModal = document.getElementById("createEventModal");
  const createEventForm = document.getElementById("createEventForm");
  const categoryFilter = document.getElementById("category");
  const sortFilter = document.getElementById("sortFilter");
  const promoList = document.getElementById("promoList");
  const detailsModal = document.getElementById("detailsModal");
  let events = [];
  let promocodes = [];

  // Ожидание загрузки всех библиотек
  const waitForLibraries = async () => {
    const maxAttempts = 30;
    let attempts = 0;
    while (attempts < maxAttempts) {
      if (
        window.solanaWeb3?.PublicKey &&
        window.solanaWeb3?.Connection &&
        window.QRCode &&
        window.jspdf &&
        window.Telegram?.WebApp
      ) {
        log("Все библиотеки загружены", {
          SolanaWeb3: !!window.solanaWeb3,
          QRCode: !!window.QRCode,
          jsPDF: !!window.jspdf,
          TelegramWebApp: !!window.Telegram?.WebApp,
        });
        return true;
      }
      log("Ожидание библиотек", {
        attempt: attempts + 1,
        SolanaWeb3: !!window.solanaWeb3,
        QRCode: !!window.QRCode,
        jsPDF: !!window.jspdf,
        TelegramWebApp: !!window.Telegram?.WebApp,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      attempts++;
    }
    logError("Не удалось загрузить библиотеки", {
      SolanaWeb3: !!window.solanaWeb3,
      QRCode: !!window.QRCode,
      jsPDF: !!window.jspdf,
      TelegramWebApp: !!window.Telegram?.WebApp,
    });
    window.showToast(
      "Ошибка загрузки библиотек. Проверьте подключение к интернету.",
    );
    return false;
  };

  // Проверка наличия Solana-кошелька
  const checkSolanaWallet = async () => {
    if (!window.solana || !window.solana.isPhantom) {
      window.showToast(
        "Solana-кошелек (например, Phantom) не найден. Установите кошелек.",
      );
      return false;
    }
    try {
      await window.solana.connect({ onlyIfTrusted: true });
      log("Solana-кошелек подключен");
      return true;
    } catch (error) {
      logError("Ошибка подключения Solana-кошелька", error.message);
      window.showToast("Не удалось подключить кошелек. Подключите вручную.");
      return false;
    }
  };

  // Получение userId
  const getUserId = () => {
    let userId;
    if (window.Telegram?.WebApp?.initDataUnsafe?.user?.id) {
      userId = window.Telegram.WebApp.initDataUnsafe.user.id.toString();
      log("Получен userId из Telegram Web App", userId);
      localStorage.setItem("userId", userId);
      return userId;
    }
    userId = localStorage.getItem("userId");
    if (!userId) {
      userId = `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      localStorage.setItem("userId", userId);
    }
    log("Используется userId", userId);
    return userId;
  };

  // Сжатие изображения перед загрузкой
  const compressImage = (
    file,
    maxWidth = 800,
    maxHeight = 800,
    quality = 0.7,
  ) => {
    return new Promise((resolve, reject) => {
      if (
        !window.URL ||
        !window.URL.createObjectURL ||
        !window.HTMLCanvasElement ||
        !HTMLCanvasElement.prototype.toBlob
      ) {
        reject(new Error("Обработка изображений не поддерживается"));
        return;
      }
      const tempUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(tempUrl);
          reject(new Error("Не удалось получить контекст canvas"));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(tempUrl);
            if (blob) {
              const compressedFile = new File([blob], file.name, {
                type: file.type,
                lastModified: Date.now(),
              });
              resolve(compressedFile);
            } else {
              reject(new Error("Не удалось сжать изображение"));
            }
          },
          file.type,
          quality,
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(tempUrl);
        reject(new Error("Не удалось загрузить изображение"));
      };
      img.src = tempUrl;
    });
  };

  // Fetch с повторными попытками
  const fetchWithRetry = async (url, options, retries = 4, delay = 3000) => {
    for (let i = 0; i < retries; i++) {
      try {
        log(`Запрос ${url}, попытка ${i + 1}/${retries}`);
        const response = await fetch(url, {
          ...options,
          signal: AbortSignal.timeout(90000),
          keepalive: true,
          cache: "no-cache",
        });
        log(`Запрос ${url} успешен`, { status: response.status });
        return response;
      } catch (error) {
        logError(`Попытка ${i + 1} не удалась для ${url}`, error.message);
        if (i === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  // Получение списка событий
  const fetchEvents = async () => {
    try {
      log("Получение событий из /api/events");
      const response = await fetchWithRetry("/api/events", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-cache",
      });
      if (!response.ok) {
        throw new Error(`Ошибка получения событий: ${response.status}`);
      }
      events = await response.json();
      log("События получены", { count: events.length });
      if (!Array.isArray(events)) {
        throw new Error("Неверный формат данных событий");
      }
      const dates = [
        ...new Set(events.map((event) => event.date).filter(Boolean)),
      ].sort();
      dateFilter.innerHTML =
        '<option value="">Усі дати</option>' +
        dates
          .map((date) => `<option value="${date}">${date}</option>`)
          .join("");
      renderEvents(events);
    } catch (error) {
      logError("Ошибка загрузки событий", error.message);
      eventsList.innerHTML =
        "<p>Помилка завантаження заходів: " +
        (error.message.includes("insufficient permissions")
          ? "Недостатньо прав доступу. Перевірте налаштування Firebase."
          : error.message) +
        "</p>";
      eventsList.querySelector(".spinner")?.remove();
      window.showToast(
        "Помилка завантаження заходів: " +
          (error.message.includes("insufficient permissions")
            ? "Недостатньо прав доступу."
            : error.message),
      );
    }
  };

  // Рендеринг событий
  const renderEvents = (eventsToRender) => {
    log("Рендеринг событий", { count: eventsToRender.length });
    eventsList.innerHTML = "";
    eventsList.querySelector(".spinner")?.remove();
    if (
      !eventsToRender ||
      !Array.isArray(eventsToRender) ||
      eventsToRender.length === 0
    ) {
      eventsList.innerHTML = "<p>Заходів поки немає</p>";
      return;
    }
    eventsToRender.forEach((event) => {
      log("Рендеринг события", { id: event.id, name: event.name });
      if (!event.id) {
        logError("Пропуск события без id", event);
        return;
      }
      const eventCard = document.createElement("div");
      eventCard.className = "event-card";
      const description =
        event.description && event.description.length > 100
          ? event.description.substring(0, 100) + "..."
          : event.description || "Без опису";
      const imageHtml = event.imageUrl
        ? `<img src="${event.imageUrl}" alt="${event.name || "Захід"}" class="event-image" onerror="this.src='/placeholder.png'; logError('Ошибка загрузки изображения:', '${event.imageUrl}')">`
        : `<div class="event-image-placeholder">Без зображення</div>`;
      eventCard.innerHTML = `
        ${imageHtml}
        <div class="event-content">
          <h3>${event.name || "Без назви"}</h3>
          <p><strong>📅 Дата:</strong> ${event.date || "Немає дати"}</p>
          <p><strong>📍 Місце:</strong> ${event.place || "Немає місця"}</p>
          <p><strong>💸 Ціна:</strong> ${event.price ? event.price + " UAH" : "Немає ціни"}</p>
          <p><strong>🎭 Категорія:</strong> ${event.category || "Немає категорії"}</p>
          <p>${description}</p>
          <div class="event-actions">
            <button class="details-button" data-event-id="${event.id}"><i class="fas fa-info-circle"></i> Деталі</button>
            <div class="pay-buttons">
              <button class="pay-button" data-event-id="${event.id}"><i class="fas fa-credit-card"></i> Тестова оплата (${event.price || 0} UAH)</button>
              <button class="pay-button solana-pay" data-event-id="${event.id}"><i class="fas fa-wallet"></i> Solana Pay</button>
            </div>
        </div>
        </div>
      `;
      eventCard
        .querySelector(".pay-button:not(.solana-pay)")
        .addEventListener("click", (e) => {
          e.preventDefault();
          showPaymentModal(event, "TestPayment");
        });
      eventCard
        .querySelector(".solana-pay")
        .addEventListener("click", async (e) => {
          e.preventDefault();
          if ((await waitForLibraries()) && (await checkSolanaWallet())) {
            showSolanaPayModal(event);
          }
        });
      eventCard
        .querySelector(".details-button")
        .addEventListener("click", () => showDetailsModal(event));
      eventsList.appendChild(eventCard);
    });
  };

  // Показ модального окна с деталями
  const showDetailsModal = (event) => {
    const detailsContent = document.getElementById("detailsContent");
    detailsContent.innerHTML = `
      <h2>${event.name || "Без назви"}</h2>
      ${event.imageUrl ? `<img src="${event.imageUrl}" alt="${event.name || "Захід"}" class="details-image" onerror="this.src='/placeholder.png';">` : '<div class="details-image-placeholder">Без зображення</div>'}
      <div class="details-info">
        <p><strong><i class="fas fa-calendar-alt"></i> Дата:</strong> ${event.date || "Немає дати"}</p>
        <p><strong><i class="fas fa-map-marker-alt"></i> Місце:</strong> ${event.place || "Немає місця"}</p>
        <p><strong><i class="fas fa-money-bill-wave"></i> Ціна:</strong> ${event.price ? event.price + " UAH" : "Немає ціни"}</p>
        <p><strong><i class="fas fa-tags"></i> Категорія:</strong> ${event.category || "Немає категорії"}</p>
        <p><strong><i class="fas fa-info-circle"></i> Опис:</strong> ${event.description || "Без опису"}</p>
      </div>
    `;
    detailsModal.style.display = "flex";
    detailsModal.classList.add("active");
  };

  // Показ модального окна оплаты
  const showPaymentModal = async (event, method) => {
    log("Показ модального окна оплаты", { eventId: event.id, method });
    const userId = getUserId();
    paymentForm.innerHTML = `
      <input type="text" id="promoCode" placeholder="Промокод">
      <button id="validatePromo"><i class="fas fa-check"></i> Перевірити промокод</button>
      <p id="promoStatus"></p>
      <button id="confirmPayment"><i class="fas fa-credit-card"></i> Оплатити</button>
    `;
    paymentModal.style.display = "flex";
    paymentModal.classList.add("active");
    const validateButton = document.getElementById("validatePromo");
    const confirmButton = document.getElementById("confirmPayment");
    const promoStatus = document.getElementById("promoStatus");
    let finalPrice = event.price || 0;
    let appliedPromoCode = "";

    validateButton.addEventListener("click", async (e) => {
      e.preventDefault();
      const promoCode = document.getElementById("promoCode").value.trim();
      if (!promoCode) {
        promoStatus.textContent = "Введіть промокод";
        return;
      }
      try {
        const response = await fetchWithRetry("/api/validate-promo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ promoCode, eventId: event.id }),
        });
        const result = await response.json();
        if (result.valid) {
          const discount = result.discount / 100;
          finalPrice = event.price * (1 - discount);
          appliedPromoCode = promoCode;
          promoStatus.textContent = `Промокод застосовано! Знижка: ${result.discount}% (Ціна: ${finalPrice.toFixed(2)} UAH)`;
          promoStatus.style.color = "#28a745";
        } else {
          promoStatus.textContent = result.error || "Невалідний промокод";
          promoStatus.style.color = "#dc3545";
        }
      } catch (error) {
        logError("Ошибка проверки промокода", error.message);
        promoStatus.textContent =
          "Помилка перевірки промокоду: " + error.message;
        promoStatus.style.color = "#dc3545";
      }
    });

    confirmButton.addEventListener(
      "click",
      async (e) => {
        e.preventDefault();
        try {
          log("Попытка тестовой покупки", {
            eventId: event.id,
            userId,
            method,
            promoCode: appliedPromoCode,
            finalPrice,
          });
          const response = await fetchWithRetry("/api/stub-purchase", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              eventId: event.id,
              userId,
              paymentMethod: method,
              promoCode: appliedPromoCode,
              finalPrice,
            }),
          });
          const result = await response.json();
          log("Ответ тестовой покупки", result);
          if (!response.ok) {
            throw new Error(
              result.error || `Ошибка запроса покупки: ${response.status}`,
            );
          }
          if (result.success) {
            const ticketData = {
              id: result.ticketId,
              ticketId: result.ticketCode,
              eventId: event.id,
              userId,
              eventName: event.name,
              eventDate: event.date,
              eventPlace: event.place,
              finalPrice,
              paymentMethod: method,
              imageUrl: event.imageUrl || "",
              createdAt: new Date().toISOString(),
            };
            let localTickets = JSON.parse(
              localStorage.getItem("tickets") || "[]",
            );
            localTickets.push(ticketData);
            localStorage.setItem("tickets", JSON.stringify(localTickets));
            log("Билет сохранен в localStorage", ticketData);
            window.showToast(
              `Оплата успішна через ${method}! Код квитка: ${result.ticketCode}`,
            );
            paymentModal.style.display = "none";
            paymentModal.classList.remove("active");
            window.dispatchEvent(
              new CustomEvent("ticketPurchased", { detail: ticketData }),
            );
            try {
              await generateTicket(event, result.ticketId, finalPrice);
            } catch (ticketError) {
              logError("Ошибка генерации билета", ticketError.message);
              window.showToast(
                "Білет створено, але PDF не згенеровано: " +
                  ticketError.message,
              );
            }
          } else {
            throw new Error(result.error || "Тестовая покупка не удалась");
          }
        } catch (error) {
          logError("Ошибка тестовой покупки", error.message);
          let errorMessage = error.message;
          if (error.name === "TimeoutError") {
            errorMessage = "Сервер не отвечает. Проверьте подключение.";
          } else if (
            error.message.includes("Failed to fetch") ||
            error.name === "TypeError"
          ) {
            errorMessage =
              "Не удалось подключиться к серверу. Попробуйте позже.";
          }
          window.showToast(`Помилка оплати: ${errorMessage}`);
        }
      },
      { once: true },
    );
  };

  // Показ модального окна Solana Pay
  const showSolanaPayModal = async (event) => {
    log("Показ модального окна Solana Pay", { eventId: event.id });
    const userId = getUserId();
    paymentForm.innerHTML = `
      <p>Скануйте QR-код у Solana-гаманці (наприклад, Phantom) для оплати ${event.price || 0} UAH.</p>
      <div id="solanaQrCode"></div>
      <p id="paymentStatus"><div class="spinner"></div> Очікування оплати...</p>
      <button id="cancelSolanaPay"><i class="fas fa-times"></i> Скасувати</button>
    `;
    paymentModal.style.display = "flex";
    paymentModal.classList.add("active");
    const paymentStatus = document.getElementById("paymentStatus");
    try {
      const price = event.price || 0;
      if (price <= 0) {
        window.showToast("Ціна заходу не вказана або недійсна");
        paymentModal.style.display = "none";
        paymentModal.classList.remove("active");
        return;
      }
      const recipient = new window.solanaWeb3.PublicKey(
        "RECIPIENT_PUBLIC_KEY" // Замените на ваш публичный ключ Solana
      );
      const reference = new window.solanaWeb3.Keypair().publicKey;
      const label = `Оплата за ${event.name}`;
      const memo = `Ticket_${event.id}`;
      // Получение курса SOL/UAH
      let amount;
      try {
        const response = await fetch(
          "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=uah",
          { signal: AbortSignal.timeout(5000) },
        );
        const data = await response.json();
        const solPerUah = data.solana.uah;
        amount = price / solPerUah;
        log("Получен курс SOL/UAH", { rate: solPerUah, amount });
      } catch (error) {
        logError("Ошибка получения курса SOL", error.message);
        amount = price * 0.01; // Резервный курс
        window.showToast(
          "Не удалось получить курс SOL. Использован стандартный курс.",
        );
      }
      const paymentUrl = `solana:${recipient.toBase58()}?amount=${amount.toFixed(8)}&reference=${reference.toBase58()}&label=${encodeURIComponent(label)}&memo=${encodeURIComponent(memo)}`;
      log("Сгенерирован URL Solana Pay", paymentUrl);
      const qrCodeDiv = document.getElementById("solanaQrCode");
      new window.QRCode(qrCodeDiv, {
        text: paymentUrl,
        width: 200,
        height: 200,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: window.QRCode.CorrectLevel.H,
      });
      const connection = new window.solanaWeb3.Connection(
        "https://api.devnet.solana.com",
        {
          commitment: "confirmed",
          confirmTransactionInitialTimeout: 60000,
        },
      );
      let timeoutId;
      const checkTransaction = async () => {
        try {
          log("Проверка транзакции", { reference: reference.toBase58() });
          paymentStatus.innerHTML = `<div class="spinner"></div> Перевірка транзакції...`;
          const response = await fetchWithRetry("/api/solana-pay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reference: reference.toBase58(),
              eventId: event.id,
              userId,
              finalPrice: event.price,
              eventName: event.name,
              eventDate: event.date,
              eventPlace: event.place,
              imageUrl: event.imageUrl,
            }),
          });
          const result = await response.json();
          log("Ответ Solana Pay", result);
          if (result.success) {
            clearTimeout(timeoutId);
            clearInterval(interval);
            const ticketData = {
              id: result.ticketId,
              ticketId: result.ticketCode,
              eventId: event.id,
              userId,
              eventName: event.name,
              eventDate: event.date,
              eventPlace: event.place,
              finalPrice: event.price,
              paymentMethod: "SolanaPay",
              imageUrl: event.imageUrl || "",
              createdAt: new Date().toISOString(),
            };
            let localTickets = JSON.parse(
              localStorage.getItem("tickets") || "[]",
            );
            localTickets.push(ticketData);
            localStorage.setItem("tickets", JSON.stringify(localTickets));
            log("Билет сохранен в localStorage", ticketData);
            paymentStatus.innerHTML =
              '<span style="color: #28a745;">Оплата успішна!</span>';
            window.showToast(
              `Оплата Solana Pay успішна! Код квитка: ${result.ticketCode}`,
            );
            setTimeout(() => {
              paymentModal.style.display = "none";
              paymentModal.classList.remove("active");
            }, 2000);
            window.dispatchEvent(
              new CustomEvent("ticketPurchased", { detail: ticketData }),
            );
            try {
              await generateTicket(event, result.ticketId, event.price);
            } catch (ticketError) {
              logError("Ошибка генерации билета", ticketError.message);
              window.showToast(
                "Білет створено, але PDF не згенеровано: " +
                  ticketError.message,
              );
            }
          } else {
            paymentStatus.innerHTML =
              '<span style="color: #dc3545;">Помилка: ' +
              result.error +
              "</span>";
            window.showToast("Помилка Solana Pay: " + result.error);
          }
        } catch (error) {
          logError("Ошибка проверки транзакции", error.message);
          paymentStatus.innerHTML =
            '<span style="color: #dc3545;">Помилка перевірки транзакції: ' +
            error.message +
            "</span>";
        }
      };
      const interval = setInterval(checkTransaction, 5000);
      timeoutId = setTimeout(() => {
        clearInterval(interval);
        paymentStatus.innerHTML =
          '<span style="color: #dc3545;">Транзакція не підтверджена</span>';
        window.showToast(
          "Транзакция Solana Pay не подтверждена. Попробуйте снова.",
        );
        paymentModal.style.display = "none";
        paymentModal.classList.remove("active");
      }, 300000);
      document
        .getElementById("cancelSolanaPay")
        .addEventListener("click", () => {
          clearInterval(interval);
          clearTimeout(timeoutId);
          paymentStatus.innerHTML =
            '<span style="color: #dc3545;">Оплата скасована</span>';
          paymentModal.style.display = "none";
          paymentModal.classList.remove("active");
        });
    } catch (error) {
      logError("Ошибка настройки Solana Pay", error.message);
      paymentStatus.innerHTML =
        '<span style="color: #dc3545;">Помилка налаштування Solana Pay: ' +
        error.message +
        "</span>";
      window.showToast("Помилка Solana Pay: " + error.message);
      paymentModal.style.display = "none";
      paymentModal.classList.remove("active");
    }
  };

  // Генерация PDF-билета
  const generateTicket = async (event, ticketId, finalPrice) => {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      doc.setFontSize(16);
      doc.text("TP TicketsPartners", 20, 20);
      doc.setFontSize(12);
      doc.text(`Квиток: ${ticketId}`, 20, 30);
      doc.text(`Захід: ${event.name || "Без назви"}`, 20, 40);
      doc.text(`Дата: ${event.date || "Немає дати"}`, 20, 50);
      doc.text(`Місце: ${event.place || "Немає місця"}`, 20, 60);
      doc.text(`Ціна: ${finalPrice.toFixed(2)} UAH`, 20, 70);
      if (event.imageUrl) {
        try {
          const imgResponse = await fetch(event.imageUrl);
          const imgBlob = await imgResponse.blob();
          const imgUrl = URL.createObjectURL(imgBlob);
          doc.addImage(imgUrl, "PNG", 20, 80, 50, 50);
          URL.revokeObjectURL(imgUrl);
        } catch (imgError) {
          logError("Ошибка загрузки изображения для PDF", imgError.message);
          doc.text("Не вдалося завантажити зображення", 20, 80);
        }
      } else {
        doc.text("Зображення відсутнє", 20, 80);
      }
      doc.save(`ticket_${ticketId}.pdf`);
    } catch (error) {
      logError("Ошибка генерации билета", error.message);
      throw new Error("Не удалось сгенерировать PDF билета: " + error.message);
    }
  };

  // Обработчик кнопки создания события
  createEventButton.addEventListener("click", () => {
    promocodes = [];
    promoList.innerHTML = "";
    createEventForm.reset();
    createEventModal.style.display = "flex";
    createEventModal.classList.add("active");
  });

  // Добавление промокода
  document.getElementById("addPromoButton").addEventListener("click", () => {
    const promoCode = document.getElementById("promoCodeInput").value.trim();
    const discount = parseFloat(
      document.getElementById("promoDiscountInput").value,
    );
    const usageLimit = parseInt(
      document.getElementById("promoLimitInput").value,
    );
    if (
      !promoCode ||
      isNaN(discount) ||
      discount <= 0 ||
      discount > 1 ||
      isNaN(usageLimit) ||
      usageLimit < 1
    ) {
      window.showToast("Заповніть усі поля промокоду коректно");
      return;
    }
    promocodes.push({ code: promoCode, discount, usageLimit });
    const promoItem = document.createElement("div");
    promoItem.className = "promo-item";
    promoItem.innerHTML = `
      ${promoCode} (Знижка: ${(discount * 100).toFixed(0)}%, Ліміт: ${usageLimit})
      <button type="button" class="remove-promo"><i class="fas fa-trash"></i></button>
    `;
    promoItem.querySelector(".remove-promo").addEventListener("click", () => {
      promocodes = promocodes.filter((p) => p.code !== promoCode);
      promoItem.remove();
    });
    promoList.appendChild(promoItem);
    document.getElementById("promoCodeInput").value = "";
    document.getElementById("promoDiscountInput").value = "";
    document.getElementById("promoLimitInput").value = "";
  });

  // Отправка формы создания события
  createEventForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    log("Отправка формы создания события");
    const formData = new FormData(createEventForm);
    const imageFile = formData.get("image");
    const eventDate = formData.get("date");
    // Валидация даты
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (new Date(eventDate) < today) {
      window.showToast("Дата заходу не може бути в минулому");
      return;
    }
    if (imageFile && imageFile.size > 0) {
      try {
        log("Сжатие изображения", {
          name: imageFile.name,
          size: imageFile.size,
        });
        const compressedImage = await compressImage(imageFile);
        log("Изображение сжато", {
          name: compressedImage.name,
          size: compressedImage.size,
        });
        formData.set("image", compressedImage);
      } catch (error) {
        logError("Ошибка сжатия изображения", error.message);
        window.showToast(`Помилка обробки зображення: ${error.message}`);
        return;
      }
    }
    formData.append("promocodes", JSON.stringify(promocodes));
    const eventData = {
      name: formData.get("name"),
      date: formData.get("date"),
      place: formData.get("place"),
      price: parseInt(formData.get("price")),
      description: formData.get("description"),
      category: formData.get("category"),
      promocodes,
    };
    if (
      !eventData.name ||
      !eventData.date ||
      !eventData.place ||
      isNaN(eventData.price) ||
      !eventData.category
    ) {
      window.showToast("Заповніть усі обов’язкові поля");
      return;
    }
    try {
      log("Отправка события на /api/event", eventData);
      const response = await fetchWithRetry("/api/event", {
        method: "POST",
        body: formData,
      });
      const result = await response.json();
      log("Ответ создания события", result);
      if (result.success) {
        window.showToast("Захід створено успішно!");
        createEventModal.style.display = "none";
        createEventModal.classList.remove("active");
        fetchEvents();
      } else {
        throw new Error(result.error || "Не удалось создать событие");
      }
    } catch (error) {
      logError("Ошибка создания события", error.message);
      let errorMessage = error.message;
      if (error.message.includes("Load failed")) {
        errorMessage =
          "Не вдалося завантажити зображення. Спробуйте менший файл.";
      } else if (error.name === "TimeoutError") {
        errorMessage =
          "Сервер не відповідає. Перевірте підключення до інтернету.";
      } else if (
        error.message.includes("Failed to fetch") ||
        error.name === "TypeError"
      ) {
        errorMessage = "Не вдалося підключитися до сервера. Спробуйте пізніше.";
      } else if (error.message.includes("insufficient permissions")) {
        errorMessage = "Недостатньо прав доступу. Перевірте Firebase.";
      }
      window.showToast(`Помилка створення заходу: ${errorMessage}`);
    }
  });

  // Поиск событий
  searchInput.addEventListener("input", (e) => {
    const search = e.target.value.toLowerCase();
    const filteredEvents = events.filter((event) =>
      (event.name || "").toLowerCase().includes(search),
    );
    log("Отфильтрованные события", { count: filteredEvents.length });
    renderEvents(filteredEvents);
  });

  // Фильтр по дате
  dateFilter.addEventListener("change", () => {
    const date = dateFilter.value;
    const filteredEvents = date
      ? events.filter((event) => event.date === date)
      : events;
    log("Фильтр по дате", { date, count: filteredEvents.length });
    renderEvents(filteredEvents);
  });

  // Фильтр по категории
  categoryFilter.addEventListener("change", () => {
    const category = categoryFilter.value;
    const filteredEvents = category
      ? events.filter((event) => event.category === category)
      : events;
    log("Фильтр по категории", { category, count: filteredEvents.length });
    renderEvents(filteredEvents);
  });

  // Сортировка событий
  sortFilter.addEventListener("change", () => {
    const sortValue = sortFilter.value;
    let sortedEvents = [...events];
    if (sortValue === "price-asc") {
      sortedEvents.sort((a, b) => (a.price || 0) - (b.price || 0));
    } else if (sortValue === "price-desc") {
      sortedEvents.sort((a, b) => (b.price || 0) - (a.price || 0));
    } else if (sortValue === "date-asc") {
      sortedEvents.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    }
    log("Сортировка событий", { sortValue, count: sortedEvents.length });
    renderEvents(sortedEvents);
  });

  // Закрытие модальных окон
  document.querySelectorAll(".close-button").forEach((button) => {
    button.addEventListener("click", () => {
      button.closest(".modal").style.display = "none";
      button.closest(".modal").classList.remove("active");
    });
  });

  // Закрытие модальных окон при клике вне контента
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
        modal.classList.remove("active");
      }
    });
  });

  // Инициализация Telegram Web App
  if (window.Telegram?.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
    log("Telegram Web App инициализирован");
  } else {
    logError("Telegram Web App не найден");
    window.showToast("Запустіть додаток через Telegram");
  }

  // Загрузка событий при старте
  if (await waitForLibraries()) {
    fetchEvents();
  }
});
