package dev.varin.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePushSupportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
