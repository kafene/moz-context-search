/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { Cc, Ci } = require("chrome");
const { console } = require("resource://gre/modules/Console.jsm");
const { Services } = require("resource://gre/modules/Services.jsm");
const { PlacesUtils } = require("resource://gre/modules/PlacesUtils.jsm");
const { get: getPref } = require("sdk/preferences/service");
const { cache } = require("sdk/lang/functional");
const tabs = require("sdk/tabs");
const self = require("sdk/self");
const base64 = require("sdk/base64");

const {
    annotations: pAnnotations,
    bookmarks: pBookmarks,
    favicons: pFavicons,
    keywords: pKeywords,
    tagging: pTagging,
    promiseFaviconData,
} = PlacesUtils;

const { error: logError } = console;

const newStringInputStream = () => Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
const newMIMEInputStream = () => Cc["@mozilla.org/network/mime-input-stream;1"].createInstance(Ci.nsIMIMEInputStream);

// moz-context-search.
const MCS = {};

MCS.gContextMenuId = "contentAreaContextMenu";
MCS.searchSelectId = "context-searchselect";
MCS.menuId = "mcs-menu";
MCS.popupId = "mcs-popup";
MCS.maxPreviewLength = 15;

// The most recently used search engine.
MCS.mruEngine = null;

// Cached reference to the default favicon URL.
MCS.getDefaultFavicon = cache(() => pFavicons.defaultFavicon.spec);

// Handler for newly opened windows.
MCS.windowListener = {
    onWindowTitleChange() {},

    onCloseWindow() {},

    onOpenWindow(xulWindow) {
        try {
            const window = xulWindow.
                QueryInterface(Ci.nsIInterfaceRequestor).
                getInterface(Ci.nsIDOMWindowInternal);

            if (!window) {
                return;
            }

            window.addEventListener("load", function onLoad() {
                window.removeEventListener("load", onLoad, false);

                MCS.initWindow(window);
            }, false);
        } catch (e) {
            console.error(e);
        }
    },
};

/**
 * @param {Ci.nsIDOMWindow} window The window to initialize.
 * @return {void}
 */
MCS.initWindow = function (window) {
    if (!window) {
        console.warn("initWindow - missing window");
        return;
    }

    const { document } = window;

    const contextMenu = document.getElementById(MCS.gContextMenuId);
    if (!contextMenu) {
        console.warn(`initWindow - missing #${MCS.gContextMenuId}`);
        return;
    }

    const searchSelect = document.getElementById(MCS.searchSelectId);
    if (!searchSelect) {
        console.warn(`initWindow - missing #${MCS.searchSelectId}`);
        return;
    }

    const mcsPopup = document.createElement("menupopup");
    mcsPopup.setAttribute("id", MCS.popupId);

    const mcsMenu = document.createElement("menu");
    mcsMenu.setAttribute("id", MCS.menuId);
    mcsMenu.setAttribute("class", "menu-iconic");
    mcsMenu.appendChild(mcsPopup);

    // Listen for clicks on the menu.
    mcsMenu.addEventListener("click", MCS.onMenuClicked, false);
    // mcsMenu.addEventListener("mousedown", MCS.onMenuClicked, false);
    // contextMenu.addEventListener("mousedown", MCS.onMenuClicked, false);

    contextMenu.insertBefore(mcsMenu, searchSelect);
    contextMenu.addEventListener("popupshowing", MCS.onPopupShowing, false);
    contextMenu.addEventListener("popupshown", MCS.onPopupShown, false);
};

/**
 * @param {Ci.nsIDOMWindow} window The window to uninitialize.
 * @return {void}
 */
MCS.uninitWindow = function (window) {
    if (!window) {
        console.warn("uninitWindow - missing window");
        return;
    }

    const { document } = window;

    const contextMenu = document.getElementById(MCS.gContextMenuId);
    if (!contextMenu) {
        console.warn(`uninitWindow - missing #${MCS.gContextMenuId}`);
        return;
    }

    const mcsMenu = document.getElementById(MCS.menuId);
    if (!mcsMenu) {
        console.warn(`uninitWindow - missing #${MCS.menuId}`);
        return;
    }

    contextMenu.removeChild(mcsMenu);
    contextMenu.removeEventListener("popupshowing", MCS.onPopupShowing, false);
    contextMenu.removeEventListener("popupshown", MCS.onPopupShown, false);
};

/**
 * #contentAreaContextMenu is showing
 *
 * @param  {Event} event The "popupshowing" event object.
 * @return {void}
 */
MCS.onPopupShowing = function (event) {
    console.info("onPopupShowing", Object.prototype.toString.call(event));
};

/**
 * #contentAreaContextMenu has shown
 *
 * @param  {Event} event The "popupshown" event object.
 * @return {void}
 */
MCS.onPopupShown = function (event) {
    /*
    const targetId = event.originalTarget ? event.originalTarget.id : event.target.id;
    // if (!targetId || targetId !== MCS.gContextMenuId) {
    if (!targetId || targetId !== MCS.popupId) {
        console.warn(`onPopupShown - event not from #${MCS.popupId}`, targetId);
        return;
    }
    */

    const window = event.view;
    if (!window) {
        console.warn("onPopupShown - missing window (event.view)");
        return;
    }

    const { document, gContextMenu } = window;

    if (!gContextMenu) {
        console.warn("onPopupShown - missing window.gContextMenu");
        return;
    }

    const searchSelect = window.document.getElementById(MCS.searchSelectId);
    if (!searchSelect) {
        console.warn(`onPopupShown - missing #${MCS.searchSelectId}`);
        return;
    }

    const mcsMenu = window.document.getElementById(MCS.menuId);
    if (!mcsMenu) {
        console.warn(`onPopupShown - missing #${MCS.menuId}`);
        return;
    }

    const mcsPopup = window.document.getElementById(MCS.popupId);
    if (!mcsPopup) {
        console.warn(`onPopupShown - missing #${MCS.popupId}`);
        return;
    }

    const isSomethingSelected = (
        gContextMenu.isTextSelected ||
        gContextMenu.isContentSelected ||
        gContextMenu.textSelected.length > 0
    );

    // Always hide the default #context-searchselect, since this replaces it.
    searchSelect.setAttribute("hidden", searchSelect.getAttribute("hidden") || true);

    // Hide the menu if nothing is selected.
    mcsMenu.setAttribute("hidden", !isSomethingSelected);

    // Empty the current popup menu.
    while (mcsPopup.children.length > 0) {
        mcsPopup.removeChild(mcsPopup.lastChild);
    }

    // @var {Array}
    const engines = Services.search.getVisibleEngines();
    if (!engines) {
        console.warn("onPopupShown - Services.search.getVisibleEngines() failed.", engines);
        // Don't return here since the default / most recent engine may still be available.
    }

    // Update the most recently used engine.
    MCS.mruEngine = MCS.mruEngine || Services.search.defaultEngine;

    // If the default engine is not one of the currently available engines, reset it to the default.
    if (engines.indexOf(MCS.mruEngine) === -1) {
        MCS.mruEngine = Services.search.defaultEngine;
    }

    if (!MCS.mruEngine || !MCS.mruEngine.name) {
        console.warn("onPopupShown - no mruEngine", MCS.mruEngine);
        return;
    }

    if (!isSomethingSelected) {
        console.info("onPopupShown - nothing selected");
        return;
    }

    const searchText = gContextMenu.textSelected;
    if (!searchText) {
        console.warn("onPopupShown - missing selected text", searchText);
        return;
    }

    const ellipsis = gContextMenu.ellipsis || "…";

    const previewText = (searchText.length > MCS.maxPreviewLength
        ? searchText.slice(0, MCS.maxPreviewLength) + ellipsis
        : searchText);

    console.log("onPopupShown - got text", { searchText, previewText });

    let menulabel,
        accesskey;
    try {
        // This now seems to work in e10s.
        const gNavigatorBundle = window.document.getElementById("bundle_browser");
        menulabel = gNavigatorBundle.getFormattedString("contextMenuSearch", [MCS.mruEngine.name, previewText]);
        accesskey = gNavigatorBundle.getString("contextMenuSearch.accesskey");
    } catch (e) {
        console.error(e);

        menulabel = `Search ${MCS.mruEngine.name} for "${previewText}"`;
        accesskey = "S";
    }

    console.log("onPopupShown - updating menu", { menulabel, accesskey, searchText });

    mcsMenu.setAttribute("label", menulabel);
    mcsMenu.setAttribute("image", MCS.mruEngine.iconURI ? MCS.mruEngine.iconURI.spec : "");
    mcsMenu.setAttribute("accesskey", accesskey);
    mcsMenu.setAttribute("searchtext", searchText);

    // Repopulate the popup menu.
    engines.forEach(engine => {
        const menuitem = document.createElement("menuitem");
        menuitem.setAttribute("label", engine.name);
        menuitem.setAttribute("class", "menuitem-iconic");
        menuitem.setAttribute("image", engine.iconURI ? engine.iconURI.spec : "");
        menuitem.setAttribute("searchtext", searchText);
        menuitem.setAttribute("tooltiptext", engine.description || "");
        // menuitem.setAttribute("accesskey", engine.name.slice(0, 1));

        menuitem.engine = engine;

        mcsPopup.appendChild(menuitem);
    });

    const searchBookmarkTag = getPref(`${self.id}.searchBookmarksTag`, "search");
    if (!searchBookmarkTag) {
        // Custom search tag is set to empty string - do not add bookmarked searches.
        return;
    }

    // add a separator between the standard engines and the bookmark search engines.
    const prependSeparator = engines.length > 0;

    MCS.getKeywordBookmarksForTag(searchBookmarkTag).
        then(keywordResults => MCS.keywordResultsToBookmarks(keywordResults)).
        then(bookmarks => MCS.promiseAllBookmarksWithFavicons(bookmarks)).
        then(bookmarks => MCS.sortBookmarksByTitle(bookmarks)).
        then(bookmarks => {
            MCS.addKeywordBookmarksMenuitems({
                bookmarks,
                searchText,
                prependSeparator,
                menupopup: mcsPopup,
            });
        }).catch(logError);
};

/**
 * A menuitem has been clicked.
 *
 * @param  {Event} event The "click" event object.
 * @return {void}
 */
MCS.onMenuClicked = function (event) {
    let whereToOpen = "tab",
        inBackground = false;
    if (event.button === Ci.nsIDOMWindowUtils.MOUSE_BUTTON_MIDDLE_BUTTON) {
        // middle click: always open in a new foreground tab.
        whereToOpen = "tab";
    } else if (event.button === Ci.nsIDOMWindowUtils.MOUSE_BUTTON_RIGHT_BUTTON) {
        // right click: always load in the current tab.
        whereToOpen = "current";
    } else if (event.button === Ci.nsIDOMWindowUtils.MOUSE_BUTTON_LEFT_BUTTON) {
        if (event.shiftKey) {
            // shift+left click: open in a new window.
            whereToOpen = "window";
        } else if (event.ctrlKey) {
            // ctrl+left click: always use a new foreground tab.
            whereToOpen = "tab";
        } else if (getPref("browser.search.context.loadInBackground", false)) {
            // left-click, no special modifiers = adhere to Firefox default pref.
            whereToOpen = "tabshifted";
            inBackground = true;
        }
    } else {
        // Not left, middle or right click. Ignore.
        return;
    }

    // @see <https://dxr.mozilla.org/mozilla-beta/source/browser/modules/ContentSearch.jsm>
    // let whereToOpen = window.whereToOpenLink(event);
    // if (whereToOpen !== "current" && Services.prefs.getBoolPref("browser.tabs.loadInBackground")) {
    //     whereToOpen = "tabshifted";
    // }

    const window = event.view;
    if (!window) {
        console.warn("onMenuClicked - missing window (event.view)");
        return;
    }

    const { document } = window;

    const contextMenu = document.getElementById(MCS.gContextMenuId);
    if (!contextMenu) {
        console.warn(`onMenuClicked - missing #${MCS.gContextMenuId}`);
        return;
    }

    // @var {Ci.nsISearchEngine}
    const engine = event.target.engine || MCS.mruEngine;
    if (!engine) {
        console.warn("onMenuClicked - missing engine");
        return;
    }

    const searchText = event.target.getAttribute("searchtext");
    if (!searchText) {
        console.warn("onMenuClicked - missing [searchtext]");
        return;
    }

    // @var {Ci.nsISearchSubmission}
    const submission = engine.getSubmission(searchText, null, "contextmenu");
    if (!submission) {
        console.warn("onMenuClicked - failed to get submission");
        return;
    }
    if (!submission.uri || !submission.uri.spec) {
        console.warn("onMenuClicked - missing submission.uri.spec", submission);
        return;
    }

    // Hide the context menu before executing the search.
    // @see <https://hg.mozilla.org/mozilla-central/rev/b71e68e61a23>
    // contextMenu.hidden = true;
    contextMenu.hidePopup();

    // Update the most recent engine
    MCS.mruEngine = engine;

    const searchURI = submission.uri.spec;
    const postData = submission.postData;

    console.log("onMenuClicked - opening link.", { searchText, searchURI, postData, whereToOpen });

    try {
        window.openLinkIn(searchURI, whereToOpen, {
            relatedToCurrent: true,
            charset: "UTF-8",
            postData,
            inBackground,
            referrerURI: "",
            referrerPolicy: Ci.nsIHttpChannel.REFERRER_POLICY_NO_REFERRER,
            noReferrer: true,
            // private: false,
            // skipTabAnimation: true,
            // allowPinnedTabHostChange: true,
            // userContextId: null,
            // indicateErrorPageLoad: false,
            // originPrincipal: null,
            // forceAboutBlankViewerInCurrent: false,
            // isContentWindowPrivate: false,
        });
    } catch (e) {
        console.error(e);
    }
};

/**
 * Resolve bookmark information for each keyword search result.
 *
 * @param  {Array<Object>} keywordResults Array of keyword search result objects.
 * @return {Array<Object>} Array of keyword result objects.
 */
MCS.keywordResultsToBookmarks = function (keywordResults) {
    return keywordResults.map(MCS.keywordResultToBookmark).filter(Boolean);
};

/**
 * Resolve bookmark information for the keyword search result.
 *
 * @param  {Object} keywordResult Keyword search result object.
 * @return {Object|null} Bookmark object with keyword result data, or null if invalid.
 */
MCS.keywordResultToBookmark = function (keywordResult) {
    const keyword = keywordResult.keyword;
    const url = keywordResult.url.href;

    const postData = keywordResult.postData ? decodeURIComponent(keywordResult.postData) : "";

    // only keep those which have a search param (`%s`), not shortcut bookmarks.
    if (!(/%s/.test(url) || /%s/.test(postData))) {
        return null;
    }

    const uri = Services.io.newURI(url);
    const bookmarkIds = pBookmarks.getBookmarkIdsForURI(uri);

    let description = "";

    let bookmarkId = null;
    if (bookmarkIds.length > 0) {
        // if it's bookmarked multiple times, just take the first URI one since
        // there's no way to associate {tag} <=> {bookmark} <=> {keyword}
        bookmarkId = bookmarkIds.find(id =>
            pBookmarks.getItemType(id) === Ci.nsINavBookmarksService.TYPE_BOOKMARK);
    }

    if (!bookmarkId) {
        return null;
    }

    // const annotations = PlacesUtils.getAnnotationsForItem(bookmarkId);
    // const description = (annotations.find(a => a.name === "bookmarkProperties/description") || {}).value || "";

    if (pAnnotations.itemHasAnnotation(bookmarkId, "bookmarkProperties/description")) {
        description = pAnnotations.getItemAnnotation(bookmarkId, "bookmarkProperties/description");
    }

    const title = pBookmarks.getItemTitle(bookmarkId);
    // const bookmarkURI = pBookmarks.getBookmarkURI(bookmarkId);

    const bookmark = {
        id: bookmarkId,
        description,
        title,
        url,
        keyword,
        iconURL: "",
        postData,
    };

    return bookmark;
};

/**
 * Fetch each favicon url into each bookmark object.
 *
 * @param  {Array<Object>} bookmarks Array of bookmark objects.
 * @return {Promise} A promise that resolves with an array of the bookmark objects with their favicon data added.
 */
MCS.promiseAllBookmarksWithFavicons = function (bookmarks) {
    // @var {Array<Promise>}
    const resolvingFavicons = bookmarks.map(MCS.resolveBookmarkFavicon);

    return Promise.all(resolvingFavicons);
};

/**
 * Fetch the favicon url into the bookmark object.
 *
 * @param  {Object} bookmark A bookmark object.
 * @return {Promise} A promise that resolves with the bookmark object with its favicon data added.
 */
MCS.resolveBookmarkFavicon = function (bookmark) {
    return promiseFaviconData(bookmark.url).then(data => {
        if (data.dataLen === 0) {
            return MCS.getDefaultFavicon();
        }

        const rawCharData = String.fromCharCode.apply(null, data.data);
        const encodedData = base64.encode(rawCharData);

        const dataURI = `data:${data.mimeType};base64,${encodedData}`;

        return Object.assign(bookmark, { iconURL: dataURI });
    }).catch(e => {
        console.error("promiseFaviconData failed", e);

        return Object.assign(bookmark, { iconURL: MCS.getDefaultFavicon() });
    });
};

/**
 * Process the combined keyword, bookmark, and favicon data (herein "bookmarks").
 * Create a menuitem for each bookmark and append it to the menupopup.
 *
 * @param {Array<Object>} options.bookmarks Bookmark objects
 * @param {Boolean} options.prependSeparator If true, prepend a separator before the keyword bookmarks menuitems
 * @param {String} options.searchText Selected text to search
 * @param {XULElement} options.menupopup Menupopup element to populate
 * @return {void}
 */
MCS.addKeywordBookmarksMenuitems = function ({
    bookmarks,
    prependSeparator,
    searchText,
    menupopup,
}) {
    console.log("adding keyword bookmarks", bookmarks);

    if (bookmarks.length === 0) {
        return;
    }

    const { ownerDocument: document } = menupopup;

    if (prependSeparator) {
        menupopup.appendChild(document.createElement("menuseparator"));
    }

    bookmarks.forEach(bookmark => {
        MCS.addKeywordBookmarkMenuitem({ bookmark, searchText, menupopup });
    });
};

/**
 * Create a menuitem for the bookmark and append it to the menupopup.
 *
 * @param {Object} options.bookmark Bookmark object
 * @param {String} options.searchText Selected text to search
 * @param {XULElement} options.menupopup Menupopup element to populate
 * @return {void}
 */
MCS.addKeywordBookmarkMenuitem = function ({ bookmark, searchText, menupopup }) {
    const { ownerDocument: document } = menupopup;

    const menuitem = document.createElement("menuitem");

    menuitem.setAttribute("label", bookmark.title);
    menuitem.setAttribute("class", "menuitem-iconic");
    menuitem.setAttribute("image", bookmark.iconURL);
    menuitem.setAttribute("searchtext", searchText);
    menuitem.setAttribute("tooltiptext", bookmark.description || "");
    // menuitem.setAttribute("accesskey", bookmark.title.slice(0, 1));

    // Create a fake "engine" object
    menuitem.engine = {
        url: bookmark.url,
        postData: bookmark.postData,
        description: bookmark.description,
        getSubmission: (searchText) => {
            const encodedText = encodeURIComponent(searchText).replace(/%20/g, "+");
            const url = bookmark.url.replace(/%s/g, encodedText);
            const uri = Services.io.newURI(url);

            let postData = null;
            if (bookmark.postData) {
                const stringStream = newStringInputStream();
                stringStream.data = bookmark.postData.replace(/%s/g, encodedText);
                postData = newMIMEInputStream();
                postData.addHeader("Content-Type", "application/x-www-form-urlencoded");
                postData.addContentLength = true;
                postData.setData(stringStream);
            }

            return { uri, postData };
        },
    };

    menupopup.appendChild(menuitem);
};

/**
 * @param  {Array<Object>} bookmarks Array of bookmark objects
 * @return {Array<Object>} The bookmarks sorted by title.
 */
MCS.sortBookmarksByTitle = function (bookmarks) {
    return bookmarks.sort((a, b) => a.title.localeCompare(b.title));
};

/**
 * @param  {String} tag The tag to find keyword bookmarks for.
 * @return {Promise} A promise that resolves with an array of keyword bookmark results.
 */
MCS.getKeywordBookmarksForTag = function (tag) {
    // @var {Array<Ci.nsIURI>}
    const uris = pTagging.getURIsForTag(tag);

    const urls = uris.map(uri => uri.spec);

    // @var {Array<Promise>}
    const fetchingKeywords = urls.map(url => pKeywords.fetch({ url }));

    return Promise.all(fetchingKeywords);
};

/**
 * Get the selected text from the currently active tab.
 * There should be better ways to do this without using tabs.activeTab
 * but since e10s, I can't find one that works consistently.
 *
 * @return {Promise} A promise that resolves with the selected text.
 */
MCS.getSelectedText = function () {
    return new Promise((resolve, reject) => {
        tabs.activeTab.attach({
            contentScript: "self.postMessage(String(getSelection()));",
            onMessage: resolve,
            onError: reject,
        });
    });
};

/**
 * Iterate all browser windows.
 *
 * @param  {Function} callback Callback which is called for each window found.
 * @return {void}
 */
function forEachBrowserWindow(callback) {
    const windows = Services.wm.getEnumerator("navigator:browser");

    while (windows.hasMoreElements()) {
        const window = windows.getNext().QueryInterface(Ci.nsIDOMWindow);

        callback(window);
    }
}

exports.main = function (options, callbacks) {
    // Handle existing windows.
    forEachBrowserWindow(MCS.initWindow);

    // Handle any newly opened windows.
    Services.wm.addListener(MCS.windowListener);
};

exports.onUnload = function (reason) {
    // Ignore app shutdown (user closing browser).
    if (reason === "shutdown") {
        return;
    }

    // Stop handling newly opened windows.
    Services.wm.removeListener(MCS.windowListener);

    // Unload from existing windows.
    forEachBrowserWindow(MCS.uninitWindow);
};
