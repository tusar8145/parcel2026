import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Who is signed in and where they work: GET /ops/overview (what they may do, their hubs, the day's numbers)
/// and the hub chosen on this phone (kept for the next start).
class Ops {
  static const _storage = FlutterSecureStorage();
  static Map<String, dynamic>? overview;

  /// The hub this phone works at (scan desk, counts, cash).
  static final hub = ValueNotifier<Map<String, dynamic>?>(null);

  static Map<String, dynamic> get _me => (overview?['me'] as Map?)?.cast<String, dynamic>() ?? {};
  static Map<String, dynamic> get can => (_me['can'] as Map?)?.cast<String, dynamic>() ?? {};
  static bool allowed(String what) => can[what] == true;

  /// The hubs this person works at (all hubs for operations managers).
  static List<Map<String, dynamic>> get hubs => ((overview?['hubs'] as List?) ?? []).cast<Map<String, dynamic>>();
  static String? get hubId => hub.value?['id'] as String?;
  static String get hubName => '${hub.value?['name'] ?? 'Choose a hub'}';
  static bool get isManager => ((_me['roles'] as List?) ?? []).contains('OPS_MANAGER');

  static Future<void> load() async {
    overview = (await Api.get('/ops/overview') as Map).cast<String, dynamic>();
    if (hubId != null && hubs.any((h) => h['id'] == hubId)) return;
    String? saved;
    try {
      saved = await _storage.read(key: 'ops.hub');
    } catch (_) {}
    final match = hubs.where((h) => h['id'] == saved).toList();
    if (match.isNotEmpty) {
      hub.value = match.first;
    } else if (hubs.length == 1) {
      hub.value = hubs.first;
    }
  }

  static Future<void> choose(Map<String, dynamic> h) async {
    hub.value = h;
    try {
      await _storage.write(key: 'ops.hub', value: '${h['id']}');
    } catch (_) {}
  }

  static void reset() {
    overview = null;
    hub.value = null;
  }
}

/// Lets the person pick their hub (search by name or code); returns true when one was chosen.
Future<bool> pickHub(BuildContext context) async {
  final hubs = Ops.hubs;
  if (hubs.isEmpty) {
    snack(context, 'No hubs found for your account.');
    return false;
  }
  final id = await pickFromList(
    context,
    title: 'Which hub are you working at?',
    items: hubs.map((h) => '${h['id']}').toList(),
    selected: Ops.hubId,
    labelOf: (id) {
      final h = hubs.firstWhere((h) => h['id'] == id);
      return '${h['name']} (${h['code']})';
    },
  );
  if (id == null) return false;
  await Ops.choose(hubs.firstWhere((h) => h['id'] == id));
  return true;
}

/// Riders to choose from (the hub's active riders first, online first, then the least busy).
Future<String?> pickRider(BuildContext context, {String title = 'Choose the rider', bool allHubs = false}) async {
  List<Map<String, dynamic>> riders;
  try {
    riders = ((await Api.get('/riders', {'active': 'true', if (!allHubs && Ops.hubId != null) 'hubId': Ops.hubId})) as List).cast<Map<String, dynamic>>();
  } catch (e) {
    if (context.mounted) snack(context, errorText(e));
    return null;
  }
  if (!context.mounted) return null;
  if (riders.isEmpty) {
    snack(context, 'No active riders at ${Ops.hubName}.');
    return null;
  }
  const rank = {'ONLINE': 0, 'ON_BREAK': 1, 'OFFLINE': 2};
  riders.sort((a, b) {
    final s = (rank[a['status']] ?? 3).compareTo(rank[b['status']] ?? 3);
    return s != 0 ? s : toNum(a['openTasks']).compareTo(toNum(b['openTasks']));
  });
  return pickFromList(
    context,
    title: title,
    items: riders.map((r) => '${r['id']}').toList(),
    labelOf: (id) {
      final r = riders.firstWhere((r) => r['id'] == id);
      return '${r['label']} · ${humanize('${r['status']}')} · ${count(r['openTasks'])} open';
    },
  );
}
