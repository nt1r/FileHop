package top.hammerbilly.filehop

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

// Register above the authenticated screen so logout/rotation cannot orphan a picker callback.
@Composable
internal fun rememberUploadPicker(beginPicker: () -> Boolean, selected: (List<Uri>) -> Unit,
    failed: () -> Unit): () -> Unit {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments(), selected)
    return {
        if (beginPicker()) {
            try { picker.launch(arrayOf("*/*")) }
            catch (_: Exception) { failed() }
        }
    }
}

@Composable
private fun UploadFileDetails(name: String, size: Long?) {
    Text(name.ifEmpty { stringResource(R.string.upload_selected_file) }, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
    if (size != null) Text(stringResource(R.string.upload_file_size, size), style = MaterialTheme.typography.labelSmall)
}

@Composable
internal fun UploadPanel(upload: UploadController, choose: () -> Unit, authenticated: Boolean = true,
    pickerAvailable: Boolean = true) {
    val state = upload.screen
    var ending by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        // Keep batch history and waiting items scrollable without pushing text sending off screen.
        Column(Modifier.fillMaxWidth().heightIn(max = 220.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (authenticated && state.phase != UploadPhase.Idle) {
                UploadFileDetails(state.name, state.size.takeIf { state.sizeKnown })
                Text(stringResource(when (state.phase) {
                    UploadPhase.Idle -> R.string.upload_waiting
                    UploadPhase.Limits -> R.string.upload_checking_limits
                    UploadPhase.Staging -> R.string.upload_staging
                    UploadPhase.Preparing -> R.string.upload_preparing
                    UploadPhase.Transferring -> R.string.upload_transferring
                    UploadPhase.Confirming -> R.string.upload_confirming
                    UploadPhase.Querying -> R.string.upload_querying
                    UploadPhase.Unconfirmed -> R.string.upload_result_unknown
                    UploadPhase.Success -> R.string.upload_success
                    UploadPhase.Failed -> R.string.upload_failed
                }), style = MaterialTheme.typography.labelLarge)
                if (state.phase in setOf(UploadPhase.Transferring, UploadPhase.Confirming)) {
                    LinearProgressIndicator(progress = { if (state.size == 0L) 1f else (state.sent.toFloat() / state.size).coerceIn(0f, 1f) },
                        modifier = Modifier.fillMaxWidth())
                    Text(stringResource(R.string.upload_byte_progress, state.sent, state.size), style = MaterialTheme.typography.labelSmall)
                } else if (state.active) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            state.noticeRes?.let { Text(stringResource(it), style = MaterialTheme.typography.bodySmall) }
            if (state.cleanupBlocked) {
                Text(stringResource(R.string.upload_cleanup_failed), style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = upload::retryCleanup, enabled = !state.settling) { Text(stringResource(R.string.upload_retry_cleanup)) }
            } else if (state.settling && !state.active) Text(stringResource(R.string.upload_finishing), style = MaterialTheme.typography.bodySmall)
            if (authenticated) {
                if (state.waiting.isNotEmpty()) Text(stringResource(R.string.upload_waiting_count, state.waiting.size),
                    style = MaterialTheme.typography.labelLarge)
                state.waiting.forEach { item -> key(item.id) {
                    Row(Modifier.fillMaxWidth()) {
                        Column(Modifier.weight(1f)) { UploadFileDetails(item.name, item.size) }
                        TextButton(onClick = { upload.removeWaiting(item.id) }) { Text(stringResource(R.string.upload_remove_waiting)) }
                    }
                } }
                state.completed.forEach { result ->
                    UploadFileDetails(result.name, result.size)
                    Text(stringResource(if (result.success) R.string.upload_success else R.string.upload_failed),
                        style = MaterialTheme.typography.labelLarge)
                    result.noticeRes?.let { Text(stringResource(it), style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
        Row {
            if (authenticated) TextButton(onClick = choose, enabled = pickerAvailable && state.canChoose) {
                Text(stringResource(R.string.upload_choose))
            }
            if (state.active && state.phase != UploadPhase.Querying) TextButton(onClick = upload::interrupt) {
                Text(stringResource(R.string.upload_interrupt))
            }
            if (authenticated && state.phase == UploadPhase.Unconfirmed) TextButton(onClick = upload::query, enabled = !state.settling) {
                Text(stringResource(R.string.action_query_result))
            }
            if (state.blocksServerChange || state.phase != UploadPhase.Idle || state.completed.isNotEmpty()) TextButton(onClick = { ending = true }) {
                Text(stringResource(R.string.upload_end_round))
            }
        }
    }
    if (ending) AlertDialog(onDismissRequest = { ending = false },
        title = { Text(stringResource(R.string.upload_end_title)) },
        text = { Text(stringResource(R.string.upload_end_warning)) },
        confirmButton = { TextButton(onClick = { ending = false; upload.endRound() }) { Text(stringResource(R.string.upload_end_round)) } },
        dismissButton = { TextButton(onClick = { ending = false }) { Text(stringResource(R.string.action_cancel)) } })
}
