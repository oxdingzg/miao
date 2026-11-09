import java.io.File

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val miaoVersion: String = run {
    val manifest = File(projectDir, "../../../package.json")
    val match = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"").find(manifest.readText())
    match?.groupValues?.get(1) ?: "0.0.0"
}

android {
    namespace = "dev.miao.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.miao.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = miaoVersion
        // Empty means the shipped Hub; a build may override it for a private relay.
        buildConfigField("String", "HUB_ORIGIN", "\"${System.getenv("MIAO_HUB_ORIGIN") ?: ""}\"")
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.core.ktx)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.zxing.embedded)
}
