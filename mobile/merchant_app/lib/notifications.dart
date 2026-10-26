import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';

import 'orders.dart';

/// Opens what a notification is about (from the list or a tapped push): a support reply its request, a
/// parcel's notification the order, a message from Delivery Fast the full text.
Future<void> openMerchantNotification(BuildContext context, Map<String, dynamic> n) async {
  final ticket = ticketIn(n);
  if (ticket != null) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketPage(number: ticket)));
    return;
  }
  final id = trackingIdIn(n);
  if (id != null) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => OrderDetailPage(trackingId: id)));
    return;
  }
  if ('${n['type']}'.startsWith('support')) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SupportPage()));
    return;
  }
  final title = '${n['title'] ?? ''}';
  if (title.isEmpty) {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsPage(onOpen: openMerchantNotification)));
    return;
  }
  await showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text('${n['body'] ?? ''}'),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
    ),
  );
}
