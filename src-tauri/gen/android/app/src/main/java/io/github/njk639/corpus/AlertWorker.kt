package io.github.njk639.corpus

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Checks PubMed for new papers while the app is closed, about twice a day.
 *
 * The web UI writes alerts.json (the searches with alerts on, the date each was last checked,
 * and the papers it already knows about). This worker asks PubMed what has been added since
 * that date and notifies about papers neither the app nor an earlier run has seen. It only
 * notifies; the app records the papers itself the next time it opens.
 */
class AlertWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val file = File(applicationContext.applicationInfo.dataDir, "alerts.json")
    if (!file.exists()) return Result.success()
    return try {
      val plan = JSONObject(file.readText())
      val apiKey = plan.optString("apiKey")
      val searches = plan.getJSONArray("searches")
      val prefs = applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val lines = ArrayList<String>()
      var total = 0
      for (i in 0 until searches.length()) {
        val s = searches.getJSONObject(i)
        val uid = s.getString("uid")
        val notified = prefs.getStringSet(uid, emptySet())!!
        val known = s.getJSONArray("known")
        val seen = HashSet<String>(notified)
        for (k in 0 until known.length()) seen.add(known.getString(k))

        val listing = newPmids(s.getString("query"), s.getString("since"), apiKey)
        val fresh = listing.filter { it !in seen }
        if (fresh.isNotEmpty()) {
          lines.add("${s.getString("name")}: ${fresh.size}")
          total += fresh.size
        }
        // Remember only ids still in the listing, so the stored set cannot grow without bound.
        prefs.edit().putStringSet(uid, (notified.filter { it in listing } + fresh).toSet()).apply()
        Thread.sleep(400) // NCBI allows three requests a second without a key.
      }
      if (total > 0) notify(total, lines)
      Result.success()
    } catch (e: Exception) {
      // Offline or PubMed is down: try again at the next scheduled run.
      Log.w("AlertWorker", "check failed", e)
      Result.success()
    }
  }

  private fun newPmids(query: String, since: String, apiKey: String): List<String> {
    val enc = { v: String -> URLEncoder.encode(v, "UTF-8") }
    var url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=100&tool=corpus" +
      "&datetype=edat&mindate=${enc(since.replace('-', '/'))}&maxdate=3000&term=${enc(query)}"
    if (apiKey.isNotEmpty()) url += "&api_key=${enc(apiKey)}"
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 20_000
    conn.readTimeout = 20_000
    try {
      val body = conn.inputStream.bufferedReader().use { it.readText() }
      val ids = JSONObject(body).getJSONObject("esearchresult").getJSONArray("idlist")
      return List(ids.length()) { ids.getString(it) }
    } finally {
      conn.disconnect()
    }
  }

  private fun notify(total: Int, lines: List<String>) {
    val ctx = applicationContext
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "New papers", NotificationManager.IMPORTANCE_DEFAULT).apply {
          description = "Papers added to PubMed that match your alerts"
        },
      )
    }
    val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)!!
      .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val n = NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(R.drawable.ic_stat_corpus)
      .setContentTitle(if (total == 1) "1 new paper" else "$total new papers")
      .setContentText(lines.joinToString(" · "))
      .setStyle(NotificationCompat.BigTextStyle().bigText(lines.joinToString("\n")))
      .setAutoCancel(true)
      .setContentIntent(PendingIntent.getActivity(ctx, 1, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
      .build()
    try {
      NotificationManagerCompat.from(ctx).notify(ID, n)
    } catch (e: SecurityException) {
      // Notifications not allowed.
    }
  }

  companion object {
    private const val PREFS = "alert_worker"
    private const val CHANNEL = "new_papers"
    private const val ID = 2001
    private const val WORK = "paper-alerts"

    fun schedule(context: Context) {
      val request = PeriodicWorkRequestBuilder<AlertWorker>(12, TimeUnit.HOURS)
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .build()
      WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }
  }
}
