package dev.dragonfox.drive

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.core.view.WindowCompat
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.ViewModelProvider
import dev.dragonfox.drive.ui.DriveApp
import dev.dragonfox.drive.ui.DriveModel

class MainActivity : ComponentActivity() {
    private lateinit var model: DriveModel
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        model = ViewModelProvider(this)[DriveModel::class.java]
        setContent {
            DriveApp(model) { dark ->
                WindowCompat.getInsetsController(window, window.decorView).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        }
    }
    override fun onStart() { super.onStart(); model.setVisible(true) }
    override fun onStop() { model.setVisible(false); super.onStop() }
}
