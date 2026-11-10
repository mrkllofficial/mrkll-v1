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
CHECKOUT
======================================*/
// The booking calendar and Stripe checkout live in js/booking.js
// (loaded only by checkout.html), driven by the real availability API.
