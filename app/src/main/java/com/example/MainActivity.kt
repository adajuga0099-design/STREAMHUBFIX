package com.example

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import java.io.ByteArrayInputStream

class MainActivity : ComponentActivity() {

    private var webView: WebView? = null
    private var customViewContainer: FrameLayout? = null
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var lastBackPressTime: Long = 0L

    // Native Ad Shield: Known ad domains, popups, and tracker hosts
    private val adHostPatterns = listOf(
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adservice.google",
        "taboola.com",
        "outbrain.com",
        "popads.net",
        "popcash.net",
        "propellerads.com",
        "propellerclick.com",
        "adsterra.com",
        "al5sm.com",
        "exoclick.com",
        "exosrv.com",
        "adnxs.com",
        "yllix.com",
        "adtrue.com",
        "trafficfactory.biz",
        "juicyads.com",
        "monetag.com",
        "hilltopads.net",
        "highcpmrevenuenetwork.com",
        "onclickbright.com",
        "propu.sh",
        "adsterraserv.com",
        "zemanta.com"
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Setup container layout
        val rootLayout = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        customViewContainer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        // Initialize WebView
        webView = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                allowFileAccess = true
                allowContentAccess = true
                useWideViewPort = true
                loadWithOverviewMode = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                setSupportMultipleWindows(false) // Block popup windows from malicious video ads
                cacheMode = WebSettings.LOAD_DEFAULT
            }

            // JavaScript Interface: Capacitor & Android bridge
            addJavascriptInterface(StreamHubBridge(this@MainActivity, this), "Android")

            webChromeClient = object : WebChromeClient() {
                // Video Fullscreen Support
                override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                    if (customView != null) {
                        callback?.onCustomViewHidden()
                        return
                    }
                    customView = view
                    customViewCallback = callback
                    this@MainActivity.webView?.visibility = View.GONE
                    customViewContainer?.addView(view)
                    customViewContainer?.visibility = View.VISIBLE
                    window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
                }

                override fun onHideCustomView() {
                    if (customView == null) return
                    customViewContainer?.removeView(customView)
                    customView = null
                    customViewContainer?.visibility = View.GONE
                    this@MainActivity.webView?.visibility = View.VISIBLE
                    customViewCallback?.onCustomViewHidden()
                    customViewCallback = null
                    window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
                }

                // Grant EME / DRM / Protected Media & Fullscreen permissions
                override fun onPermissionRequest(request: PermissionRequest?) {
                    request?.grant(request.resources)
                }

                override fun onCreateWindow(
                    view: WebView?,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: android.os.Message?
                ): Boolean {
                    // Block unwanted window.open popups
                    return false
                }
            }

            webViewClient = object : WebViewClient() {
                // Native Ad Shield: Intercept and block ad network network requests
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val host = request?.url?.host?.lowercase() ?: return null
                    for (adHost in adHostPatterns) {
                        if (host == adHost || host.endsWith(".$adHost")) {
                            return WebResourceResponse(
                                "text/plain",
                                "UTF-8",
                                200,
                                "OK",
                                emptyMap(),
                                ByteArrayInputStream(ByteArray(0))
                            )
                        }
                    }
                    return super.shouldInterceptRequest(view, request)
                }

                // Popup and redirect protection
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url ?: return false
                    val host = url.host?.lowercase() ?: ""

                    // Check if redirect targets an ad domain
                    for (adHost in adHostPatterns) {
                        if (host == adHost || host.endsWith(".$adHost")) {
                            return true // Block navigation
                        }
                    }

                    val scheme = url.scheme?.lowercase() ?: ""
                    // Handle special schemes safely
                    if (scheme != "http" && scheme != "https" && scheme != "file" && scheme != "about") {
                        return try {
                            val intent = Intent(Intent.ACTION_VIEW, url)
                            startActivity(intent)
                            true
                        } catch (e: Exception) {
                            true
                        }
                    }

                    // Keep inside internal player / WebView
                    return false
                }

                override fun onRenderProcessGone(
                    view: WebView?,
                    detail: RenderProcessGoneDetail?
                ): Boolean {
                    // Gracefully prevent app crash if the graphics/Mesa renderer process is killed or resets
                    try {
                        if (view != null) {
                            (view.parent as? ViewGroup)?.removeView(view)
                            view.destroy()
                        }
                        webView = null
                        recreate()
                    } catch (e: Exception) {
                        // ignore
                    }
                    return true
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    super.onReceivedError(view, request, error)
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // Inject Capacitor Bridge shim
                    view?.evaluateJavascript(
                        """
                        if (!window.Capacitor) {
                            window.Capacitor = {
                                isNativePlatform: function() { return true; },
                                getPlatform: function() { return 'android'; },
                                Plugins: {
                                    Browser: {
                                        open: async function(opts) {
                                            if (window.Android && window.Android.openCustomTab) {
                                                window.Android.openCustomTab(opts.url);
                                            }
                                        }
                                    }
                                }
                            };
                        }
                        """.trimIndent(),
                        null
                    )
                }
            }

            loadUrl("file:///android_asset/index.html")
        }

        rootLayout.addView(webView)
        rootLayout.addView(customViewContainer)
        setContentView(rootLayout)

        // Setup Back Button Navigation
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // 1. If video is in fullscreen, exit fullscreen first
                if (customView != null) {
                    webView?.webChromeClient?.onHideCustomView()
                    return
                }

                // 2. Ask Web application if it handled back (e.g., player close, modal close, settings back)
                webView?.evaluateJavascript("window.handleBackAction ? window.handleBackAction() : false") { result ->
                    val handled = result?.trim()?.equals("true", ignoreCase = true) == true
                    if (!handled) {
                        // 3. If on home page, double back to exit
                        val now = System.currentTimeMillis()
                        if (now - lastBackPressTime < 2000L) {
                            finish()
                        } else {
                            lastBackPressTime = now
                            Toast.makeText(
                                this@MainActivity,
                                "Tekan sekali lagi untuk keluar",
                                Toast.LENGTH_SHORT
                            ).show()
                        }
                    }
                }
            }
        })
    }

    // Launch In-App Browser / Custom Tab (Capacitor Browser fallback)
    fun openCustomTab(url: String) {
        try {
            val customTabsIntent = CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
            customTabsIntent.launchUrl(this, Uri.parse(url))
        } catch (e: Exception) {
            try {
                val fallbackIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                startActivity(fallbackIntent)
            } catch (ignored: Exception) {
                Toast.makeText(this, "Tidak dapat membuka tautan", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
    }

    override fun onPause() {
        webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    // Bridge for Javascript communication
    class StreamHubBridge(private val activity: MainActivity, private val webView: WebView) {

        @JavascriptInterface
        fun openCustomTab(url: String) {
            activity.runOnUiThread {
                activity.openCustomTab(url)
            }
        }

        @JavascriptInterface
        fun setUserAgent(ua: String?) {
            activity.runOnUiThread {
                if (!ua.isNullOrBlank()) {
                    webView.settings.userAgentString = ua
                } else {
                    webView.settings.userAgentString = WebSettings.getDefaultUserAgent(activity)
                }
            }
        }

        @JavascriptInterface
        fun setWebViewUserAgent(ua: String?) {
            setUserAgent(ua)
        }

        @JavascriptInterface
        fun shareUrl(url: String, title: String?) {
            activity.runOnUiThread {
                val sendIntent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, url)
                    putExtra(Intent.EXTRA_TITLE, title ?: "STREAMHUB")
                }
                activity.startActivity(Intent.createChooser(sendIntent, "Bagikan"))
            }
        }
    }
}

@Composable
fun Greeting(name: String, modifier: Modifier = Modifier) {
    androidx.compose.material3.Text(text = "Hello $name!", modifier = modifier)
}
