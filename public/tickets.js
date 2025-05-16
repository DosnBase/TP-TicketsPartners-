const isDev = true; // Установлено true для отладки; в продакшене можно установить false
const log = (...args) => isDev && console.log(...args);
const logError = (...args) => console.error(...args);

document.addEventListener("DOMContentLoaded", async () => {
  const ticketsList = document.getElementById("ticketsList");

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

  // Получение билетов
  const fetchTickets = async () => {
    const userId = getUserId();
    try {
      log("Получение билетов из /api/tickets", { userId });
      const response = await fetchWithRetry(`/api/tickets/${userId}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-cache",
      });
      if (!response.ok) {
        throw new Error(`Ошибка получения билетов: ${response.status}`);
      }
      const tickets = await response.json();
      log("Билеты получены", { count: tickets.length });
      renderTickets(tickets);
    } catch (error) {
      logError("Ошибка загрузки билетов", error.message);
      ticketsList.innerHTML =
        "<p>Помилка завантаження квитків: " + error.message + "</p>";
      ticketsList.querySelector(".spinner")?.remove();
      window.showToast("Помилка завантаження квитків: " + error.message);
    }
  };

  // Рендеринг билетов
  const renderTickets = (tickets) => {
    log("Рендеринг билетов", { count: tickets.length });
    ticketsList.innerHTML = "";
    ticketsList.querySelector(".spinner")?.remove();
    if (!tickets || !Array.isArray(tickets) || tickets.length === 0) {
      ticketsList.innerHTML = "<p>Квитків поки немає</p>";
      return;
    }
    tickets.forEach((ticket) => {
      log("Рендеринг билета", { id: ticket.id, ticketId: ticket.ticketId });
      const ticketCard = document.createElement("div");
      ticketCard.className = "ticket-card";
      ticketCard.innerHTML = `
        <h3>${ticket.eventName || "Без назви"}</h3>
        <p><strong>🎟️ Код квитка:</strong> ${ticket.ticketId || "Немає коду"}</p>
        <p><strong>📅 Дата:</strong> ${ticket.eventDate || "Немає дати"}</p>
        <p><strong>📍 Місце:</strong> ${ticket.eventPlace || "Немає місця"}</p>
        <p><strong>💸 Ціна:</strong> ${ticket.finalPrice ? ticket.finalPrice + " UAH" : "Немає ціни"}</p>
        <p><strong>💳 Метод оплати:</strong> ${ticket.paymentMethod || "Немає методу"}</p>
        <div class="ticket-actions">
          <button class="download-ticket" data-ticket-id="${ticket.ticketId}"><i class="fas fa-download"></i> Завантажити PDF</button>
        </div>
      `;
      ticketCard
        .querySelector(".download-ticket")
        .addEventListener("click", () => generateTicket(ticket));
      ticketsList.appendChild(ticketCard);
    });
  };

  // Генерация PDF-билета
  const generateTicket = async (ticket) => {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();
      doc.setFontSize(16);
      doc.text("TP TicketsPartners", 20, 20);
      doc.setFontSize(12);
      doc.text(`Квиток: ${ticket.ticketId || "Немає коду"}`, 20, 30);
      doc.text(`Захід: ${ticket.eventName || "Без назви"}`, 20, 40);
      doc.text(`Дата: ${ticket.eventDate || "Немає дати"}`, 20, 50);
      doc.text(`Місце: ${ticket.eventPlace || "Немає місця"}`, 20, 60);
      doc.text(
        `Ціна: ${ticket.finalPrice ? ticket.finalPrice + " UAH" : "Немає ціни"}`,
        20,
        70,
      );
      if (ticket.imageUrl) {
        try {
          const imgResponse = await fetch(ticket.imageUrl);
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
      doc.save(`ticket_${ticket.ticketId}.pdf`);
    } catch (error) {
      logError("Ошибка генерации билета", error.message);
      window.showToast("Помилка створення PDF: " + error.message);
    }
  };

  // Инициализация Telegram Web App
  if (window.Telegram?.WebApp) {
    window.Telegram.WebApp.ready();
    window.Telegram.WebApp.expand();
    log("Telegram Web App инициализирован");
  } else {
    logError("Telegram Web App не найден");
    window.showToast("Запустіть додаток через Telegram");
  }

  // Загрузка билетов при старте
  fetchTickets();
});
