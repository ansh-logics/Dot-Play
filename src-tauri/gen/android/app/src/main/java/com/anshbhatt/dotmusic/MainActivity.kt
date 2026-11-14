package com.anshbhatt.dotmusic

import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // A music receiver: the screensaver must not take over (and stop the page) mid-song.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Playback starts when the desktop app says so, with no button pressed on the TV.
    webView.settings.mediaPlaybackRequiresUserGesture = false
    // Without focus the page never hears the remote's keys.
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    webView.requestFocus()
  }
}
