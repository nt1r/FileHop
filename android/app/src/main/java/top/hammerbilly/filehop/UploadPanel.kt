package top.hammerbilly.filehop

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp

// Register above the authenticated screen so logout/rotation cannot orphan a picker callback.
@Composable
internal fun rememberUploadPicker(upload: UploadController, label: String): () -> Unit {
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument(), upload::pickerResult)
    return {
        if (upload.beginPicker(label)) {
            try { picker.launch(arrayOf("*/*")) }
            catch (_: Exception) { upload.pickerFailed() }
        }
    }
}

@Composable
internal fun UploadPanel(upload: UploadController, choose: () -> Unit, authenticated: Boolean = true) {
    val state = upload.screen
    var ending by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (authenticated && state.phase != UploadPhase.Idle) {
            if (state.name.isNotEmpty()) {
                Text(state.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                Text(stringResource(R.string.upload_file_size, state.size), style = MaterialTheme.typography.labelSmall)
            }
            Text(stringResource(when (state.phase) {
                UploadPhase.Idle, UploadPhase.Waiting -> R.string.upload_waiting
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
        Row {
            if (authenticated) TextButton(onClick = choose, enabled = !state.blocksServerChange && !state.cleanupBlocked) {
                Text(stringResource(R.string.upload_choose))
            }
            if (state.active && state.phase != UploadPhase.Querying) TextButton(onClick = upload::interrupt) {
                Text(stringResource(R.string.upload_interrupt))
            }
            if (authenticated && state.phase == UploadPhase.Unconfirmed) TextButton(onClick = upload::query, enabled = !state.settling) {
                Text(stringResource(R.string.action_query_result))
            }
            if (state.active || state.phase == UploadPhase.Unconfirmed) TextButton(onClick = { ending = true }) {
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
