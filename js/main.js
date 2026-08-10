const hamburger = document.getElementById("hamburger");
const mobileMenu = document.getElementById("mobileMenu");

if(hamburger){

    hamburger.addEventListener("click", () => {

        mobileMenu.classList.toggle("active");

    });

}


/* =========================
   SCROLL REVEAL
========================= */
const sections = document.querySelectorAll("section");

sections.forEach(section=>{
    section.classList.add("reveal");
});

const revealOnScroll = () => {

    sections.forEach(section=>{

        const top = section.getBoundingClientRect().top;

        if(top < window.innerHeight * 0.9){

            section.classList.add("active");

        }

    });

};

window.addEventListener("scroll", revealOnScroll);

revealOnScroll();

const navbar = document.querySelector(".navbar");

window.addEventListener("scroll",()=>{

    if(window.scrollY>30){

        navbar.classList.add("scrolled");

    }else{

        navbar.classList.remove("scrolled");

    }

});

/* =========================
   ACTIVE PAGE
========================= */

const current = window.location.pathname
    .split("/")
    .pop()
    .split("?")[0]
    .split("#")[0];

const navLinks = document.querySelectorAll(".nav-link");

let activePage = current;

if (
    current === "booking.html" ||
    current === "mixing.html" ||
    current === "mastering.html"
){
    activePage = "studios.html";
}

navLinks.forEach(link => {

    if(link.getAttribute("href") === activePage){

        link.classList.add("active");

    }

});

/*======================================
MRKLL PACKAGE DETECTION
======================================*/

const params = new URLSearchParams(window.location.search);

const packageType = params.get("package");

const packageName = document.getElementById("package-name");
const packageDuration = document.getElementById("package-duration");
const packagePrice = document.getElementById("package-price");

let bookingDuration = 4;
let bookingPrice = 200;

if (packageName) {

    switch(packageType){

        case "starter":

            packageName.textContent = "Recording Starter";
            packageDuration.textContent = "2 Hours";
            packagePrice.textContent = "€120";

            bookingDuration = 2;
            bookingPrice = 120;

        break;

        case "legend":

            packageName.textContent = "Recording Legend";
            packageDuration.textContent = "6 Hours";
            packagePrice.textContent = "€280";

            bookingDuration = 6;
            bookingPrice = 280;

        break;

        default:

            packageName.textContent = "Recording Pro";
            packageDuration.textContent = "4 Hours";
            packagePrice.textContent = "€200";

            bookingDuration = 4;
            bookingPrice = 200;

    }

}

/* =========================
   CHECKOUT CALENDAR
========================= */

const calendar = document.getElementById("calendarDays");

if(calendar){

const slotsContainer=document.getElementById("timeSlots");

const selectedDate=document.getElementById("selected-date");

const sessionTime = document.getElementById("session-time");

const continueBtn=document.querySelector(".summary-card .btn");

let slots = [];

switch(packageType){

    case "starter":

        slots = [
            "10:00",
            "12:00",
            "14:00",
            "16:00",
            "18:00"
        ];

    break;

    case "legend":

        slots = [
            "10:00",
            "13:00"
        ];

    break;

    default:

        slots = [
            "10:00",
            "14:00",
            "18:00"
        ];

}
// Giorni completamente occupati
const bookedDays = [4, 8, 12, 17, 22, 28];

// Alcuni orari occupati
const bookedSlots = {
    2: ["14:00"],
    5: ["10:00","12:00"],
    9: ["16:00"],
    14:["12:00","18:00"],
    18:["10:00"],
    24:["14:00","16:00"],
    30:["12:00"]
};

let currentDay = null;
const today = new Date();

const currentYear = today.getFullYear();

const currentMonth = today.getMonth();

const firstDay = new Date(currentYear, currentMonth, 1);

const lastDay = new Date(currentYear, currentMonth + 1, 0);

// Trasforma Sunday=0 in Monday=0
let startDay = firstDay.getDay();
startDay = (startDay + 6) % 7;

// Svuota il calendario
calendar.innerHTML = "";

// Celle vuote prima del giorno 1
for(let i = 0; i < startDay; i++){

    const empty = document.createElement("div");

    empty.className = "calendar-empty";

    calendar.appendChild(empty);

}
for(let i = 1; i <= lastDay.getDate(); i++){

    const day = document.createElement("div");

    day.className = "calendar-day";

    day.innerText = i;

    const isBooked = bookedDays.includes(i);

    if(isBooked){
        day.classList.add("disabled");
    }

    const dayDate = new Date(currentYear, currentMonth, i);

    dayDate.setHours(0,0,0,0);

    const todayDate = new Date();

    todayDate.setHours(0,0,0,0);

    const isPast = dayDate <= todayDate;

const monthDifference =
    (dayDate.getFullYear() - currentYear) * 12 +
    (dayDate.getMonth() - currentMonth);

const isFutureLocked = monthDifference > 1;

    if(isPast){
        day.classList.add("past-day");
    }

    if(isFutureLocked){
        day.classList.add("future-day");
    }

    day.onclick = () => {

        if(isPast || isFutureLocked || isBooked) return;

        currentDay = i;

        document
            .querySelectorAll(".calendar-day")
            .forEach(d => d.classList.remove("active"));

        day.classList.add("active");

        selectedDate.innerText = dayDate.toLocaleDateString("en-GB",{
            day:"numeric",
            month:"long",
            year:"numeric"
        });

        renderSlots();

    };

    // SEMPRE aggiunto al calendario
    calendar.appendChild(day);

}


function renderSlots(){

slotsContainer.innerHTML="";

slots.forEach(time=>{

    const unavailable =
    bookedSlots[currentDay] &&
    bookedSlots[currentDay].includes(time);

const slot=document.createElement("div");

slot.className="slot";

if(unavailable){
    slot.classList.add("unavailable");
}
slot.innerText=time;

slot.onclick=()=>{

    if(unavailable) return;
document.querySelectorAll(".slot").forEach(s=>s.classList.remove("active"));

slot.classList.add("active");

const [hour, minute] = time.split(":").map(Number);

const endHour = hour + bookingDuration;

const endTime =
`${String(endHour).padStart(2,"0")}:${String(minute).padStart(2,"0")}`;

sessionTime.innerText = `${time} — ${endTime}`;

continueBtn.disabled = false;

};

slotsContainer.appendChild(slot);

});

}

continueBtn.addEventListener("click", async () => {

    if (continueBtn.disabled) return;

    const selectedTime = sessionTime.innerText.split(" — ")[0];

    try {

        const response = await fetch("/api/create-checkout-session", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                packageType: packageType,
                date: selectedDate.innerText,
                time: selectedTime
            })
        });

        const data = await response.json();

        if (data.url) {
            window.location.href = data.url;
            return;
        }

        console.error("Stripe error:", data);
        alert("Unable to start payment.");

    } catch (error) {

        console.error("Checkout error:", error);
        alert("Unable to connect to payment service.");

    }

});

}