plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "top.hammerbilly.filehop"
    compileSdk {
        version = release(37) { minorApiLevel = 2 }
    }
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "top.hammerbilly.filehop"
        minSdk = 36
        targetSdk = 36
        versionCode = providers.gradleProperty("filehopVersionCode").orElse("1").get().toInt()
        versionName = providers.gradleProperty("filehopVersionName").orElse("0.1.0").get()
        val origin = providers.gradleProperty("filehopDefaultOrigin").orElse("https://filehop.example.invalid").get()
        require(origin.matches(Regex("https://[A-Za-z0-9.-]+(:[0-9]+)?/?")))
        buildConfigField("String", "DEFAULT_ORIGIN", "\"$origin\"")
    }
    signingConfigs {
        create("release") {
            val path = System.getenv("FILEHOP_KEYSTORE")
            if (path != null) {
                storeFile = file(path)
                storePassword = System.getenv("FILEHOP_STORE_PASSWORD")
                keyAlias = System.getenv("FILEHOP_KEY_ALIAS")
                keyPassword = System.getenv("FILEHOP_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        debug { applicationIdSuffix = ".dev"; versionNameSuffix = "-dev" }
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    testImplementation("junit:junit:4.13.2")
}
