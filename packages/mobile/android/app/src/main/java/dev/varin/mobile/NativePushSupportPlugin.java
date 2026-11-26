package dev.varin.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.firebase.FirebaseApp;

@CapacitorPlugin(name = "NativePushSupport")
public class NativePushSupportPlugin extends Plugin {
    @PluginMethod
    public void getAvailability(PluginCall call) {
        boolean available = FirebaseApp.getApps(getContext()).stream()
            .anyMatch(app -> FirebaseApp.DEFAULT_APP_NAME.equals(app.getName()));
        JSObject result = new JSObject();
        result.put("available", available);
        call.resolve(result);
    }
}
