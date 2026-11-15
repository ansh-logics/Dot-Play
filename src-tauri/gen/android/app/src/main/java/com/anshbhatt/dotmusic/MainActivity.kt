package com.anshbhatt.dotmusic

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.system.Os
import android.util.Log
import android.view.WindowManager
import android.webkit.WebView
import java.util.UUID

/** The port the Rust side listens on for the desktop app (`link::PORT`). */
private const val LINK_PORT = 47873
private const val SERVICE_TYPE = "_dotplay._tcp"

class MainActivity : TauriActivity() {
  private var registration: NsdManager.RegistrationListener? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // Before the Rust side starts: it reads who this TV is from the environment.
    Os.setenv("DOTPLAY_DEVICE_ID", deviceId(), true)
    Os.setenv("DOTPLAY_DEVICE_NAME", deviceName(), true)
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

  override fun onStart() {
    super.onStart()
    advertise()
  }

  override fun onStop() {
    registration?.let {
      try {
        (getSystemService(Context.NSD_SERVICE) as NsdManager).unregisterService(it)
      } catch (_: IllegalArgumentException) {
        // Never registered.
      }
    }
    registration = null
    super.onStop()
  }

  /** A stable id for this TV, made once. The desktop app tells linked TVs apart by it. */
  private fun deviceId(): String {
    val prefs = getSharedPreferences("link", Context.MODE_PRIVATE)
    prefs.getString("id", null)?.let { return it }
    val id = UUID.randomUUID().toString().replace("-", "")
    prefs.edit().putString("id", id).apply()
    return id
  }

  /** The name set in the TV's settings ("Living Room TV"), or its model. */
  private fun deviceName(): String {
    val named = Settings.Global.getString(contentResolver, "device_name")
    return (named?.takeIf { it.isNotBlank() } ?: Build.MODEL ?: "TV").take(60)
  }

  /** Lets the desktop app find this TV on the local network while it is on screen. */
  private fun advertise() {
    if (registration != null) return
    val info = NsdServiceInfo().apply {
      serviceName = deviceName()
      serviceType = SERVICE_TYPE
      port = LINK_PORT
      setAttribute("id", deviceId())
    }
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) {}
      override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
        Log.w("dotplay", "Advertising on the network failed: $errorCode")
      }
      override fun onServiceUnregistered(info: NsdServiceInfo) {}
      override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
    }
    registration = listener
    (getSystemService(Context.NSD_SERVICE) as NsdManager).registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
  }
}
