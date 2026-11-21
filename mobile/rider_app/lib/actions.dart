import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'offline.dart';
import 'phone.dart';

/// The rider's parcel actions, each sent through the outbox (now, or saved until online with its
/// Idempotency-Key) and answered as a scan result. Every lifecycle rule stays on the server; these only
/// refuse what the phone already knows is wrong (not on your list, already done).

String _savedNote(Sent s) => s == Sent.later ? ' · saved, sends when online' : '';

Map<String, dynamic>? findTask(String list, String code) {
  for (final p in Tasks.list(list)) {
    if (p['trackingId'] == code) return p;
  }
  return null;
}

/// Pickup from merchant: collected at [stop] (the API refuses a parcel of another stop).
Future<ScanFeedback> collectParcel(Map<String, dynamic> stop, String code, {String outcome = 'COLLECTED', String? note}) async {
  final known = findTask('pickups', code) != null;
  // Offline, a parcel not on the list can't be checked on the phone: refuse it rather than guess.
  if (!known && savedAt.value != null) return ScanFeedback(false, '$code is not on your pickup list.');
  try {
    final sent = await Outbox.send(
      Pending(
        id: Outbox.newId(),
        path: '/rider/parcels/${Uri.encodeComponent(code)}/pickup',
        body: {'outcome': outcome, if (outcome == 'COLLECTED') 'expectedStop': stop['key'], 'note': ?note},
        label: switch (outcome) {
          'EXCEPTION' => 'Pickup problem: $note',
          'COLLECTED_DELIVER_DIRECT' => 'Collected, delivering now',
          _ => 'Collected from ${stop['name'] ?? 'the sender'}',
        },
        trackingId: code,
        kind: 'pickup',
        createdAt: DateTime.now(),
      ),
    );
    return ScanFeedback(true, '$code ${outcome == 'EXCEPTION' ? 'reported' : 'collected'}${_savedNote(sent)}');
  } on ApiError catch (e) {
    return ScanFeedback(false, e.message);
  }
}

/// Hand over at hub: on the hub's handover list (the hub scans it in to confirm).
Future<ScanFeedback> handOver(Map<String, dynamic> hub, String code, String source) async {
  try {
    final sent = await Outbox.send(
      Pending(
        id: Outbox.newId(),
        path: '/rider/parcels/${Uri.encodeComponent(code)}/handover',
        body: {'hubId': hub['id'], 'source': source == 'KEYBOARD' ? 'KEYBOARD' : 'CAMERA'},
        label: 'Handed over at ${hub['name'] ?? 'the hub'}',
        trackingId: code,
        kind: 'handover',
        createdAt: DateTime.now(),
      ),
    );
    return ScanFeedback(true, '$code handed over${_savedNote(sent)}');
  } on ApiError catch (e) {
    return ScanFeedback(false, e.message);
  }
}

/// Start delivery: out for delivery, and the recipient gets their delivery code by SMS.
Future<ScanFeedback> startDelivery(String code) async {
  final p = findTask('deliveries', code);
  if (p == null) return ScanFeedback(false, '$code is not one of your deliveries.');
  final pending = Outbox.of(code);
  if (p['status'] == 'OUT_FOR_DELIVERY' || (pending?.kind == 'start' && pending?.error == null)) return ScanFeedback(false, '$code is already out for delivery.');
  try {
    final sent = await Outbox.send(
      Pending(id: Outbox.newId(), path: '/rider/parcels/${Uri.encodeComponent(code)}/start-delivery', body: {}, label: 'Delivery started', trackingId: code, kind: 'start', createdAt: DateTime.now()),
    );
    return ScanFeedback(true, '$code out for delivery${sent == Sent.now ? ' · code sent to the recipient' : _savedNote(sent)}');
  } on ApiError catch (e) {
    return ScanFeedback(false, e.message);
  }
}

/// Couldn't deliver: the same reason and next step for every parcel scanned.
Future<ScanFeedback> failDelivery(String code, {required String reason, required String nextAction, String? note}) async {
  if (findTask('deliveries', code) == null) return ScanFeedback(false, '$code is not one of your deliveries.');
  try {
    final sent = await Outbox.send(
      Pending(
        id: Outbox.newId(),
        path: '/rider/parcels/${Uri.encodeComponent(code)}/delivery',
        body: {'outcome': 'FAILED', 'reason': reason, 'nextAction': nextAction, 'note': ?note},
        label: 'Not delivered: $reason (${nextAction == 'RETRY' ? 'try again' : 'return to sender'})',
        trackingId: code,
        kind: 'failed',
        createdAt: DateTime.now(),
      ),
    );
    return ScanFeedback(true, '$code saved: $reason${_savedNote(sent)}');
  } on ApiError catch (e) {
    return ScanFeedback(false, e.message);
  }
}

/// Return to merchant: the merchant took this parcel of the return run back.
Future<ScanFeedback> returnParcel(Map<String, dynamic> run, String code, String source, String receivedBy) async {
  final codes = ((run['parcels'] as List?) ?? []).map((p) => '${(p as Map)['trackingId']}').toSet();
  if (!codes.contains(code)) return ScanFeedback(false, '$code is not on ${run['number']}.');
  try {
    final sent = await Outbox.send(
      Pending(
        id: Outbox.newId(),
        path: '/rider/parcels/${Uri.encodeComponent(code)}/return',
        body: {'runId': run['id'], if (receivedBy.isNotEmpty) 'receivedBy': receivedBy, 'source': source == 'KEYBOARD' ? 'KEYBOARD' : 'CAMERA'},
        label: 'Returned to ${(run['merchant'] as Map?)?['name'] ?? 'the merchant'}',
        trackingId: code,
        kind: 'return',
        createdAt: DateTime.now(),
      ),
    );
    return ScanFeedback(true, '$code returned${_savedNote(sent)}');
  } on ApiError catch (e) {
    return ScanFeedback(false, e.message);
  }
}

/// Directions in Google Maps to the merchant of a return run (its map position, else its address).
Future<void> merchantDirections(BuildContext context, Map run) {
  final m = (run['merchant'] as Map?) ?? {};
  final lat = m['lat'], lng = m['lng'];
  return openDirections(context, lat: lat == null ? null : toNum(lat).toDouble(), lng: lng == null ? null : toNum(lng).toDouble(), address: '${m['address'] ?? ''}');
}

/// Returned to merchant, the step before scanning: where the merchant is (directions, call), then "At the merchant".
Future<bool> goToMerchant(BuildContext context, Map run) async {
  final m = (run['merchant'] as Map?) ?? {};
  final n = ((run['parcels'] as List?) ?? []).length;
  final go = await showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('${run['number']} · ${m['name'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 17)),
            if ('${m['address'] ?? ''}'.isNotEmpty) Text('${m['address']}', style: const TextStyle(color: muted)),
            Text('$n parcel(s) to give back', style: const TextStyle(color: muted)),
            const SizedBox(height: 14),
            FilledButton.icon(
              onPressed: () => merchantDirections(context, run),
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(46)),
              icon: const Icon(Icons.directions),
              label: const Text('Directions in Google Maps'),
            ),
            if (m['phone'] != null) ...[
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: () => callPhone(context, '${m['phone']}'),
                style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46)),
                icon: const Icon(Icons.call_outlined),
                label: const Text('Call the merchant'),
              ),
            ],
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: () => Navigator.pop(context, true),
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(46), foregroundColor: good),
              icon: const Icon(Icons.qr_code_scanner),
              label: const Text('At the merchant: scan the parcels'),
            ),
          ],
        ),
      ),
    ),
  );
  return go == true;
}
