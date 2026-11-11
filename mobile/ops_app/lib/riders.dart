import 'dart:math';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'ops.dart';

/// Adding riders and setting their passwords from the app: operations managers and Hub Managers (POST /riders/app,
/// POST /riders/:id/password; a Hub Manager only at their own hub) and franchise hubs (/franchise/riders…).
/// The password is set here and shared by hand: no invitation is sent. After saving, the sign-in details (mobile,
/// email, password and the rider app's download link) are shown to copy.

/// 12 letters and digits (no look-alikes such as 0/O, 1/l), always with both.
String newPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  final rnd = Random.secure();
  String pick(String set) => set[rnd.nextInt(set.length)];
  final chars = [pick(letters), pick(digits), for (var i = 0; i < 10; i++) pick(letters + digits)]..shuffle(rnd);
  return chars.join();
}

/// null when the password is fine, else what is wrong with it.
String? passwordProblem(String v) {
  if (v.length < 10) return 'Use at least 10 characters';
  if (v.length > 128) return 'Use at most 128 characters';
  if (!RegExp(r'[A-Za-z]').hasMatch(v) || !RegExp(r'\d').hasMatch(v)) return 'Use at least one letter and one number';
  return null;
}

/// The password field with Generate.
class _PasswordField extends StatelessWidget {
  const _PasswordField({required this.controller, this.label = 'Password'});
  final TextEditingController controller;
  final String label;

  @override
  Widget build(BuildContext context) => TextField(
    controller: controller,
    decoration: InputDecoration(
      labelText: label,
      helperText: '10+ characters, a letter and a number',
      suffixIcon: TextButton(onPressed: () => controller.text = newPassword(), child: const Text('Generate')),
    ),
  );
}

/// The new rider's details; null when cancelled. Keys: name, phone, email, password.
Future<Map<String, String>?> riderForm(BuildContext context, {required String title, String? note}) async {
  final name = TextEditingController();
  final phone = TextEditingController();
  final email = TextEditingController();
  final password = TextEditingController(text: newPassword());
  String? error;
  return showDialog<Map<String, String>>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: Text(title),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (note != null) Text(note, style: const TextStyle(color: muted)),
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Name')),
              TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Mobile (01XXXXXXXXX)')),
              TextField(controller: email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email (optional)')),
              _PasswordField(controller: password),
              if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: bad))),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final problem = name.text.trim().length < 2
                  ? "Enter the rider's name"
                  : !RegExp(r'^(?:\+?880|0)?1[3-9]\d{8}$').hasMatch(phone.text.replaceAll(RegExp(r'[\s-]'), ''))
                  ? 'Enter a valid mobile number'
                  : passwordProblem(password.text);
              if (problem != null) return setState(() => error = problem);
              Navigator.pop(context, {'name': name.text.trim(), 'phone': normalizePhone(phone.text.trim()), 'email': email.text.trim(), 'password': password.text});
            },
            child: const Text('Add rider'),
          ),
        ],
      ),
    ),
  );
}

/// A new password for [who]; null when cancelled.
Future<String?> askNewPassword(BuildContext context, String who) async {
  final password = TextEditingController(text: newPassword());
  String? error;
  return showDialog<String>(
    context: context,
    builder: (context) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        title: Text('New password for $who'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('They are signed out everywhere and sign in with their mobile number and this password.', style: TextStyle(color: muted)),
            _PasswordField(controller: password, label: 'New password'),
            if (error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(error!, style: const TextStyle(color: bad))),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final problem = passwordProblem(password.text);
              if (problem != null) return setState(() => error = problem);
              Navigator.pop(context, password.text);
            },
            child: const Text('Set password'),
          ),
        ],
      ),
    ),
  );
}

/// The sign-in details to share with the rider, each with a copy button, and "Copy all".
Future<void> showSignInDetails(
  BuildContext context, {
  required String title,
  required String phone,
  String? email,
  String? password,
  String? appLink,
  String? note,
}) async {
  final rows = <(String, String)>[
    ('Mobile', phoneText(phone)),
    if (email != null && email.isNotEmpty) ('Email', email),
    if (password != null) ('Password', password),
    if (appLink != null && appLink.isNotEmpty) ('Rider app', appLink),
  ];
  final all = rows.map((r) => '${r.$1}: ${r.$2}').join('\n');
  Future<void> copy(BuildContext context, String text, String what) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (context.mounted) snack(context, '$what copied.');
  }

  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (note != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(note, style: const TextStyle(color: muted))),
          for (final r in rows)
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(r.$1, style: const TextStyle(color: muted, fontSize: 12)),
              subtitle: SelectableText(r.$2, style: const TextStyle(fontWeight: FontWeight.w700, color: Colors.black87)),
              trailing: IconButton(tooltip: 'Copy', icon: const Icon(Icons.copy), onPressed: () => copy(context, r.$2, r.$1)),
            ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close')),
        FilledButton.icon(onPressed: () => copy(context, all, 'Sign-in details'), icon: const Icon(Icons.copy_all), label: const Text('Copy all')),
      ],
    ),
  );
}

/// Adds a rider through [path] and shows the sign-in details; true when one was added.
Future<bool> addRiderVia(BuildContext context, {required String path, Map<String, dynamic> extra = const {}, String title = 'Add a rider', String? note}) async {
  final f = await riderForm(context, title: title, note: note);
  if (f == null || !context.mounted) return false;
  try {
    final made = await Api.post(path, {'name': f['name'], 'phone': f['phone'], if (f['email']!.isNotEmpty) 'email': f['email'], 'password': f['password'], ...extra});
    final m = made is Map ? made.cast<String, dynamic>() : <String, dynamic>{};
    final kept = m['passwordSet'] == false;
    if (context.mounted) {
      await showSignInDetails(
        context,
        title: '${m['code'] ?? ''} ${f['name']} added'.trim(),
        phone: '${m['phone'] ?? f['phone']}',
        email: '${m['email'] ?? f['email'] ?? ''}',
        password: kept ? null : f['password'],
        appLink: '${m['appLink'] ?? ''}',
        note: kept
            ? 'This number already had an account: they sign in with their own password (the one typed here was not applied).'
            : 'No message was sent. Share these with the rider: they install the rider app and sign in with the mobile number and password.',
      );
    }
    return true;
  } on ApiError catch (e) {
    if (context.mounted) snack(context, e.message);
    return false;
  }
}

/// Sets a rider's new password through [path] and shows the sign-in details.
Future<void> resetRiderPasswordVia(BuildContext context, {required String path, required Map<String, dynamic> rider}) async {
  final who = '${rider['label'] ?? '${rider['code']} · ${rider['name']}'}';
  final password = await askNewPassword(context, who);
  if (password == null || !context.mounted) return;
  try {
    final r = ((await Api.post(path, {'password': password})) as Map).cast<String, dynamic>();
    if (context.mounted) {
      await showSignInDetails(context, title: 'New password set', phone: '${r['phone'] ?? rider['phone'] ?? ''}', email: '${r['email'] ?? ''}', password: password, appLink: '${r['appLink'] ?? ''}');
    }
  } on ApiError catch (e) {
    if (context.mounted) snack(context, e.message);
  }
}

/// Riders at the phone's hub (Hub Managers: their own hub), with Add rider and New password.
class RidersPage extends StatefulWidget {
  const RidersPage({super.key});

  @override
  State<RidersPage> createState() => _RidersPageState();
}

class _RidersPageState extends State<RidersPage> {
  late Future<List<Map<String, dynamic>>> _riders = _load();

  Future<List<Map<String, dynamic>>> _load() async =>
      ((await Api.get('/riders', {if (Ops.hubId != null) 'hubId': Ops.hubId})) as List).cast<Map<String, dynamic>>();

  void _reload() => setState(() => _riders = _load());

  Future<void> _add() async {
    if (Ops.hubId == null && !await pickHub(context)) return;
    if (!mounted) return;
    final added = await addRiderVia(context, path: '/riders/app', extra: {'hubId': Ops.hubId}, title: 'Add a rider at ${Ops.hubName}');
    if (added) _reload();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Riders · ${Ops.hubName}')),
      floatingActionButton: FloatingActionButton.extended(onPressed: _add, icon: const Icon(Icons.person_add_alt_1), label: const Text('Add rider')),
      body: FutureBuilder<List<Map<String, dynamic>>>(
        future: _riders,
        builder: (context, snap) {
          if (snap.hasError) return Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(errorText(snap.error!))));
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final riders = snap.data!;
          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
              children: [
                if (riders.isEmpty) const EmptyView(icon: Icons.two_wheeler, text: 'No riders at this hub yet.'),
                for (final r in riders)
                  Panel(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(child: Text('${r['label'] ?? '${r['code']} · ${r['name']}'}', style: const TextStyle(fontWeight: FontWeight.w800))),
                            StatusChip(r['active'] == true ? '${r['status']}' : 'INACTIVE', label: r['active'] == true ? humanize('${r['status']}') : 'Inactive'),
                          ],
                        ),
                        Text([phoneText(r['phone']), if ((r['email'] ?? '') != '') '${r['email']}'].join(' · '), style: const TextStyle(color: muted)),
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton.icon(
                            onPressed: () => resetRiderPasswordVia(context, path: '/riders/${r['id']}/password', rider: r),
                            icon: const Icon(Icons.lock_reset),
                            label: const Text('New password'),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}
