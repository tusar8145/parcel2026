import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'api.dart';
import 'widgets.dart';

/// Forced updates: when the server answers APP_UPDATE_REQUIRED (this version is below the app's minimum, set in
/// super admin › Mobile apps), the app shows a page it can't leave, with the download link of the new version.
class AppUpdate {
  static bool _shown = false;

  static void required(String message, String? url) {
    if (_shown) return;
    _shown = true;
    void open() {
      final nav = navigatorKey.currentState;
      if (nav == null) {
        WidgetsBinding.instance.addPostFrameCallback((_) => open());
        return;
      }
      nav.pushAndRemoveUntil(MaterialPageRoute(builder: (_) => UpdateRequiredPage(message: message, url: url)), (_) => false);
    }

    open();
  }
}

class UpdateRequiredPage extends StatelessWidget {
  const UpdateRequiredPage({super.key, required this.message, this.url});
  final String message;
  final String? url;

  @override
  Widget build(BuildContext context) {
    final link = url;
    return PopScope(
      canPop: false,
      child: Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.system_update, size: 64, color: brand),
                  const SizedBox(height: 16),
                  const Text('Update the app', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 10),
                  Text(
                    link == null ? message : 'This version of ${AppConfig.appName} (${AppConfig.version}) no longer works. Download and install the new version, then open the app again.',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: muted, fontSize: 15),
                  ),
                  if (link != null) ...[
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                      onPressed: () async {
                        if (!await launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication) && context.mounted) snack(context, 'Could not open the browser. Copy the link instead.');
                      },
                      icon: const Icon(Icons.download),
                      label: const Text('Download the new version'),
                    ),
                    const SizedBox(height: 10),
                    SelectableText(link, textAlign: TextAlign.center, style: const TextStyle(color: muted)),
                    TextButton.icon(
                      onPressed: () async {
                        await Clipboard.setData(ClipboardData(text: link));
                        if (context.mounted) snack(context, 'Link copied.');
                      },
                      icon: const Icon(Icons.copy),
                      label: const Text('Copy the link'),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
