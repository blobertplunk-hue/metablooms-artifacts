package com.metablooms.share;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String BASE = "https://gltzernwlrxrsdejxuyt.supabase.co/functions/v1/metablooms-mobile";
    private static final String AUTOPAIR = "https://gltzernwlrxrsdejxuyt.supabase.co/functions/v1/metablooms-autopair";
    private static final String PREFS = "metablooms_share";
    private static final String TOKEN_KEY = "device_token";
    private static final int MAX_FILE_BYTES = 25_000_000;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final List<Uri> sharedUris = new ArrayList<>();
    private EditText contentBox;
    private EditText contextBox;
    private TextView pairStatus;
    private TextView fileSummary;
    private TextView sendStatus;
    private Button saveButton;
    private Button retryPairButton;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        buildUi();
        handleIntent(getIntent());
        refreshPairUi();
        if (token().length() < 32) autoPair();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private SharedPreferences prefs() { return getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private String token() { return prefs().getString(TOKEN_KEY, ""); }

    private TextView text(String value, int sp) {
        TextView v = new TextView(this);
        v.setText(value); v.setTextSize(sp); v.setTextColor(Color.WHITE);
        v.setPadding(0, 8, 0, 8); return v;
    }

    private Button button(String label) {
        Button b = new Button(this); b.setText(label); return b;
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(17,17,17));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(28,28,28,40);
        scroll.addView(root, new ScrollView.LayoutParams(-1,-2));

        root.addView(text("MetaBlooms", 26));
        root.addView(text("Share from any Android app, review it, then save it to MetaBlooms.", 15));

        pairStatus = text("Connecting to MetaBlooms…", 15);
        pairStatus.setTextColor(Color.LTGRAY);
        root.addView(pairStatus);
        retryPairButton = button("Retry connection");
        retryPairButton.setVisibility(android.view.View.GONE);
        retryPairButton.setOnClickListener(v -> autoPair());
        root.addView(retryPairButton);

        root.addView(text("Shared text / URL", 18));
        contentBox = new EditText(this);
        contentBox.setMinLines(4);
        contentBox.setGravity(android.view.Gravity.TOP);
        contentBox.setTextColor(Color.WHITE);
        contentBox.setHintTextColor(Color.GRAY);
        contentBox.setHint("Text or URL shared to MetaBlooms");
        root.addView(contentBox, new LinearLayout.LayoutParams(-1,-2));

        root.addView(text("Optional context", 18));
        contextBox = new EditText(this);
        contextBox.setTextColor(Color.WHITE);
        contextBox.setHintTextColor(Color.GRAY);
        contextBox.setHint("Example: math lesson, field trip, idea");
        root.addView(contextBox);

        fileSummary = text("No shared files.", 14);
        fileSummary.setTextColor(Color.LTGRAY);
        root.addView(fileSummary);

        saveButton = button("Save to MetaBlooms");
        saveButton.setOnClickListener(v -> saveShared());
        root.addView(saveButton);

        sendStatus = text("", 14);
        root.addView(sendStatus);
        setContentView(scroll);
    }

    private void refreshPairUi() {
        boolean paired = token().length() >= 32;
        if (paired) {
            pairStatus.setText("Connected — ready for Android Share");
            pairStatus.setTextColor(Color.rgb(150,255,150));
            retryPairButton.setVisibility(android.view.View.GONE);
            saveButton.setEnabled(true);
        } else {
            pairStatus.setText("Connecting to MetaBlooms…");
            pairStatus.setTextColor(Color.LTGRAY);
            saveButton.setEnabled(false);
        }
    }

    private void autoPair() {
        pairStatus.setText("Connecting to MetaBlooms…");
        pairStatus.setTextColor(Color.LTGRAY);
        retryPairButton.setVisibility(android.view.View.GONE);
        saveButton.setEnabled(false);
        io.execute(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(AUTOPAIR).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(15000);
                c.setReadTimeout(30000);
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                String body = new JSONObject().put("label", "MetaBlooms Android Share").toString();
                try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                String response = readResponse(c);
                JSONObject j = new JSONObject(response);
                String t = j.optString("device_token", "");
                if (t.length() < 32) throw new Exception("pairing response missing token");
                prefs().edit().putString(TOKEN_KEY, t).apply();
                runOnUiThread(() -> {
                    refreshPairUi();
                    Toast.makeText(this, "MetaBlooms connected", Toast.LENGTH_SHORT).show();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    pairStatus.setText("Could not connect: " + e.getMessage());
                    pairStatus.setTextColor(Color.rgb(255,150,150));
                    retryPairButton.setVisibility(android.view.View.VISIBLE);
                });
            }
        });
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        sharedUris.clear();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            String tx = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (tx != null) contentBox.setText(tx);
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            if (u != null) sharedUris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            String tx = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (tx != null) contentBox.setText(tx);
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
            if (list != null) sharedUris.addAll(list);
        }
        updateFileSummary();
    }

    private void updateFileSummary() {
        if (sharedUris.isEmpty()) { fileSummary.setText("No shared files."); return; }
        StringBuilder b = new StringBuilder("Shared files: ");
        for (int i=0;i<sharedUris.size();i++) {
            if (i>0) b.append(", ");
            b.append(displayName(sharedUris.get(i)));
        }
        fileSummary.setText(b.toString());
    }

    private String displayName(Uri uri) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        String p = uri.getLastPathSegment();
        return p == null ? "shared-file" : p;
    }

    private void saveShared() {
        if (token().length() < 32) {
            sendStatus.setText("Connecting to MetaBlooms. Try again in a moment.");
            sendStatus.setTextColor(Color.rgb(255,180,120));
            autoPair();
            return;
        }
        String text = contentBox.getText().toString().trim();
        String context = contextBox.getText().toString().trim();
        if (text.isEmpty() && sharedUris.isEmpty()) { sendStatus.setText("Nothing to save."); return; }
        saveButton.setEnabled(false);
        sendStatus.setTextColor(Color.LTGRAY);
        sendStatus.setText("Saving…");
        io.execute(() -> {
            try {
                int saved = 0;
                if (!text.isEmpty()) {
                    postJson("capture", new JSONObject().put("content", text).put("context", context).toString());
                    saved++;
                }
                for (Uri uri : sharedUris) { upload(uri, context); saved++; }
                int count = saved;
                runOnUiThread(() -> {
                    sendStatus.setTextColor(Color.rgb(150,255,150));
                    sendStatus.setText("Saved " + count + " item" + (count==1?"":"s") + " to MetaBlooms.");
                    Toast.makeText(this, "Saved to MetaBlooms", Toast.LENGTH_SHORT).show();
                    new Handler(Looper.getMainLooper()).postDelayed(this::finish, 700);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    saveButton.setEnabled(true);
                    sendStatus.setTextColor(Color.rgb(255,150,150));
                    sendStatus.setText("Save failed: " + e.getMessage());
                });
            }
        });
    }

    private String postJson(String api, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + "?api=" + api).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setDoOutput(true);
        c.setRequestProperty("x-device-token", token());
        c.setRequestProperty("content-type", "application/json");
        try (OutputStream out = c.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
        return readResponse(c);
    }

    private String upload(Uri uri, String context) throws Exception {
        ContentResolver r = getContentResolver();
        String name = displayName(uri);
        String mime = r.getType(uri);
        if (mime == null) mime = "application/octet-stream";
        byte[] bytes = readLimited(uri);
        String boundary = "----MetaBlooms" + UUID.randomUUID();
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + "?api=upload").openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setDoOutput(true);
        c.setRequestProperty("x-device-token", token());
        c.setRequestProperty("content-type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream out = c.getOutputStream()) {
            writePart(out,boundary,"context",context.getBytes(StandardCharsets.UTF_8),"text/plain; charset=utf-8",null);
            writePart(out,boundary,"file",bytes,mime,name);
            out.write(("--"+boundary+"--\r\n").getBytes(StandardCharsets.UTF_8));
        }
        return readResponse(c);
    }

    private byte[] readLimited(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) throw new Exception("Cannot read shared file");
            byte[] buf = new byte[65536];
            int total=0,n;
            while ((n=in.read(buf))!=-1) {
                total += n;
                if (total > MAX_FILE_BYTES) throw new Exception("File is larger than 25 MB");
                out.write(buf,0,n);
            }
            return out.toByteArray();
        }
    }

    private static void writePart(OutputStream out,String boundary,String field,byte[] data,String contentType,String fileName) throws Exception {
        String disp = "Content-Disposition: form-data; name=\""+field+"\"" + (fileName==null?"":"; filename=\""+fileName.replace("\"","_")+"\"") + "\r\n";
        out.write(("--"+boundary+"\r\n"+disp+"Content-Type: "+contentType+"\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private static String readResponse(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream in = code>=200&&code<300 ? c.getInputStream() : c.getErrorStream();
        String body = "";
        if (in != null) {
            try (InputStream input=in; ByteArrayOutputStream out=new ByteArrayOutputStream()) {
                input.transferTo(out);
                body = out.toString(StandardCharsets.UTF_8);
            }
        }
        if (code < 200 || code >= 300) throw new Exception("HTTP " + code + (body.isEmpty()?"":": "+body));
        return body;
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        if (isFinishing()) io.shutdownNow();
    }
}
