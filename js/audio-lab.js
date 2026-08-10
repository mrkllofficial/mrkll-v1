
const timeline = document.querySelector(".timeline");

const handle = document.querySelector(".timeline-handle");

const playButton = document.getElementById("play");

const restart = document.getElementById("restart");

restart.addEventListener("click", () => {

    currentAudio.currentTime = 0;

    updateProgress();

});

const projectDuration = document.getElementById("projectDuration");

const rawAudio = document.getElementById("audioRaw");
const mixedAudio = document.getElementById("audioMixed");

const currentTime = document.getElementById("current");
const duration = document.getElementById("duration");

const progress = document.querySelector(".timeline-progress");

const rawBtn = document.getElementById("rawBtn");
const mixedBtn = document.getElementById("mixedBtn");

let currentAudio = rawAudio;
let playing = false;

function formatTime(seconds){

    if(isNaN(seconds)) return "00:00";

    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);

    return (
        String(minutes).padStart(2,"0") +
        ":" +
        String(secs).padStart(2,"0")
    );

}

function updateTime(){

    currentTime.textContent = formatTime(currentAudio.currentTime);
    
    const remaining =
        currentAudio.duration - currentAudio.currentTime;
    
    duration.textContent = "-" + formatTime(remaining);
    


    projectDuration.textContent =
        formatTime(currentAudio.duration);

    progress.style.width = (currentAudio.currentTime/currentAudio.duration)*100 + "%";

    handle.style.left = progress.style.width;
}

function playCurrent(){

    currentAudio.play();

    playButton.innerHTML="❚❚";

    playing=true;

}

function pauseCurrent(){

    currentAudio.pause();

    playButton.innerHTML="▶";

    playing=false;

}

playButton.addEventListener("click",()=>{

    if(playing){

        pauseCurrent();

    }else{

        playCurrent();

    }

});

rawAudio.addEventListener("loadedmetadata",updateTime);
mixedAudio.addEventListener("loadedmetadata",updateTime);

rawAudio.addEventListener("timeupdate",()=>{

    if(currentAudio===rawAudio){

        updateTime();

    }

});

mixedAudio.addEventListener("timeupdate",()=>{

    if(currentAudio===mixedAudio){

        updateTime();

    }

});

rawAudio.addEventListener("ended",()=>{

    if(currentAudio===rawAudio){

        pauseCurrent();

        currentAudio.currentTime = 0;

        updateTime();

    }

});

mixedAudio.addEventListener("ended",()=>{

    if(currentAudio===mixedAudio){

        pauseCurrent();

        currentAudio.currentTime = 0;

        updateTime();

    }

});

rawBtn.addEventListener("click",()=>{

    if(currentAudio===rawAudio) return;

    const time=currentAudio.currentTime;

    currentAudio.pause();

    currentAudio=rawAudio;

    currentAudio.currentTime=time;

    rawBtn.classList.add("active");
    mixedBtn.classList.remove("active");

    if(playing){

        currentAudio.play();

    }

});

mixedBtn.addEventListener("click",()=>{

    if(currentAudio===mixedAudio) return;

    const time=currentAudio.currentTime;

    currentAudio.pause();

    currentAudio=mixedAudio;

    currentAudio.currentTime=time;

    mixedBtn.classList.add("active");
    rawBtn.classList.remove("active");

    if(playing){

        currentAudio.play();

    }

});

/* ===========================
   DEMO SWITCH
=========================== */

const demos = {

    fulltrack: {

        title: "Full Track Demo",

        raw: "audio/fulltrack-raw.mp3",

        mixed: "audio/fulltrack-mixed.mp3",

        changes: [

            "Better punch",

            "Better stereo image",

            "Controlled low end",

            "Better clarity"

        ]

    },

    vocals: {

        title: "Vocals Demo",

        raw: "audio/vocals-raw.mp3",

        mixed: "audio/vocals-mixed.mp3",

        changes: [

            "Cleaner vocal",

            "Better compression",

            "More presence",

            "Better ambience"

        ]

    }

};

const tabs = document.querySelectorAll(".audio-tab");

const projectTitle = document.getElementById("projectTitle");

const changesList = document.getElementById("changesList");

tabs.forEach(tab=>{

    tab.addEventListener("click",()=>{

        tabs.forEach(t=>t.classList.remove("active"));

        tab.classList.add("active");

        const demo = demos[tab.dataset.demo];

        projectTitle.textContent = demo.title;

        rawAudio.pause();

        mixedAudio.pause();

        playing = false;

        playButton.innerHTML="▶";

        rawAudio.src = demo.raw;

        mixedAudio.src = demo.mixed;

        rawAudio.load();

        mixedAudio.load();

        currentAudio = rawAudio;

        rawBtn.classList.add("active");

        mixedBtn.classList.remove("active");

        changesList.innerHTML="";

        demo.changes.forEach(change=>{

            const li=document.createElement("li");

            li.textContent=change;

            changesList.appendChild(li);

        });

    });

});

timeline.addEventListener("click",(e)=>{

    const rect = timeline.getBoundingClientRect();

    const percent = (e.clientX - rect.left) / rect.width;

    currentAudio.currentTime = percent * currentAudio.duration;

    updateTime();

});