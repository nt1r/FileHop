buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        // AGP's built-in Kotlin uses this explicit newer KGP instead of its bundled minimum.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21")
    }
}

plugins {
    id("com.android.application") version "9.4.1" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
