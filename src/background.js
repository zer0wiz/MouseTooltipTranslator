"use strict";

//handle translation, setting and pdf
//it communicate with popup.js(for setting) and contentScript.js(for translation and tts)
//for setting, it save and load from chrome storage
//for translation, use fetch to get translated  result

//tooltip background===========================================================================
import { Setting } from "./setting";
import translator from "./translator/index.js";



var setting;
var settingLoaded = false;
var recentTranslated = {};
var translateWithCache=cacheFn(doTranslate);
getSetting();

//listen message from contents js and popup js =========================================================================================================
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  (async () => {
    if (settingLoaded == false) {
      await getSetting();
    }

    if (request.type === "translate") {
      var translatedResult = await translateWithCache(
      // var translatedResult = await doTranslate(
        request.word,
        setting.data["translateSource"],
        request.translateTarget,
        setting.data["translatorVendor"]
      );
      sendResponse(translatedResult);
    } else if (request.type === "tts") {
      doTts(request.word, request.lang, setting.data["ttsVolume"] ,setting.data["ttsRate"] );
      sendResponse({});
    } else if (request.type === "stopTTS") {
      chrome.tts.stop();
      sendResponse({});
    } else if (request.type === "updateRecentTranslated") {
      recordHistory(request);
      updateContext(request);
      sendResponse({});
    }
  })();

  return true;
});

async function getSetting() {
  setting = await Setting.create();
  settingLoaded = true;
}

function recordHistory(request, force = false) {
  //if action not included
  if (
    force ||
    setting.data["historyRecordActions"].includes(request.actionType)
  ) {
    //append history to front
    setting.data["historyList"].unshift({
      sourceText: request.sourceText,
      targetText: request.targetText,
    });
    //remove when too many list
    if (setting.data["historyList"].length > 1000) {
      setting.data["historyList"].pop();
    }
    setting.save();
  }
}



async function doTts(word, lang, ttsVolume,ttsRate) {
  var voice =setting.data["ttsVoice_"+lang]

  chrome.tts.speak(word, {
    lang: lang,
    voiceName: voice,
    volume: Number(ttsVolume),  
    rate: Number(ttsRate), 
  });
}

async function doTranslate(text, fromLang, targetLang, translatorVendor) {
  return translator[translatorVendor].translate(text, fromLang, targetLang);
}

// detect local pdf file and redirect to translated pdf=====================================================================
chrome.tabs.onUpdated.addListener(
  function(tabId, changeInfo, tab) {
    var url=(changeInfo.url?changeInfo.url:'').toLowerCase();

    if(!url||changeInfo.status!="loading"||setting.data["detectPDF"] == "false" ){
      return;
    }

    //check local pdf file, open with viewer
    if( checkIsLocalPdfUrl(url) ){
      openPDFViewer(url, tabId);
    }
  }
);


//url is end with .pdf, start with file://
function checkIsLocalPdfUrl(url){
  return /^(file:\/\/).*(\.pdf)$/.test(url)   
}
async function openPDFViewer(url, tabId) {
  chrome.tabs.update(tabId, {
    url:
      chrome.runtime.getURL("/pdfjs/web/viewer.html") +
      "?file=" +
      encodeURIComponent(url),
  });
}



// ================= context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "copy",
    title: "copy",
    visible: false,
  });
});

function updateContext(request) {
  chrome.contextMenus.update("copy", {
    title: "Copy : " + truncate(request.targetText, 20),
    contexts: ["page", "selection"],
    visible: true,
  });
  recentTranslated = request;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId == "copy") {
    runFunctionOnTab(tab.id,copyText,[recentTranslated.targetText])
  }
});

function copyText(text) {  
  navigator.clipboard.writeText(text);
}

function runFunctionOnTab(tabId,func,args){
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: func,
    args: args,
  });
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "..." : str;
}



// ================= contents script reinjection after upgrade or install
// https://stackoverflow.com/questions/10994324/chrome-extension-content-script-re-injection-after-upgrade-or-install
chrome.runtime.onInstalled.addListener(async () => {
  for (const cs of chrome.runtime.getManifest().content_scripts) {
    for (const tab of await chrome.tabs.query({ url: cs.matches })) {
      if (
        /^(chrome:\/\/|edge:\/\/|file:\/\/|https:\/\/chrome\.google\.com\/webstore|chrome-extension:\/\/).*/.test(
          tab.url
        )
      ) {
        continue;
      }

      //load css and js on opened tab
      chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: cs.css,
      });
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: cs.js,
      });         
    }
  }
});



// performance=======================================================
function cacheFn(fn) {
  var cache={};

  return function(){
    var args = arguments;  
    var key = [].slice.call(args).join('');
    if (1000<Object.keys( cache ).length ) {
      cache={}//numbers.shift();
    }

    if(cache[key]){
        return cache[key];
    }
    else{
        cache[key] = fn.apply(this, args);
        return cache[key];
    }
  }
}
// debounce