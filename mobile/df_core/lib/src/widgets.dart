import 'package:flutter/material.dart';

import 'api.dart';

const brand = Color(0xFF2F55C9);
const ink = Color(0xFF283041);
const muted = Color(0xFF667085);
const line = Color(0xFFE4E7EC);
const page = Color(0xFFF4F6FB);
const good = Color(0xFF067647);
const warn = Color(0xFFB54708);
const bad = Color(0xFFB42318);

void snack(BuildContext context, String message) => ScaffoldMessenger.of(context)
  ..hideCurrentSnackBar()
  ..showSnackBar(SnackBar(content: Text(message), behavior: SnackBarBehavior.floating));

/// The message for an error, with a plain line when the server is an older version without the feature.
String errorText(Object error) {
  if (error is ApiError && error.notOnServer) return 'This feature is not available on the server yet. Please update the server and try again.';
  return error is ApiError ? error.message : 'Something went wrong. Please try again.';
}

/// Loads [load] and shows a spinner, the error with "Try again", or [builder]'s content.
class Loader<T> extends StatefulWidget {
  const Loader({super.key, required this.load, required this.builder});
  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, Future<void> Function() reload) builder;

  @override
  State<Loader<T>> createState() => LoaderState<T>();
}

class LoaderState<T> extends State<Loader<T>> {
  late Future<T> _future = widget.load();

  Future<void> reload() async {
    final f = widget.load();
    setState(() {
      _future = f;
    });
    try {
      await f;
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
        if (snap.hasError) return ErrorView(message: errorText(snap.error!), onRetry: reload);
        return widget.builder(context, snap.data as T, reload);
      },
    );
  }
}

class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.message, this.onRetry});
  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_outlined, size: 44, color: muted),
            const SizedBox(height: 12),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: muted),
            ),
            if (onRetry != null) ...[const SizedBox(height: 14), OutlinedButton.icon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Try again'))],
          ],
        ),
      ),
    );
  }
}

class EmptyView extends StatelessWidget {
  const EmptyView({super.key, required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 24),
      child: Column(
        children: [
          Icon(icon, size: 44, color: const Color(0xFF98A2B3)),
          const SizedBox(height: 10),
          Text(
            text,
            textAlign: TextAlign.center,
            style: const TextStyle(color: muted),
          ),
        ],
      ),
    );
  }
}

/// A white card with an optional title.
class Panel extends StatelessWidget {
  const Panel({super.key, this.title, this.trailing, required this.child, this.padding = const EdgeInsets.all(14)});
  final String? title;
  final Widget? trailing;
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    // A Material (not a decorated box), so list tiles and switches inside show their ink.
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: const BorderSide(color: line),
        ),
        child: Padding(
          padding: padding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (title != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          title!,
                          style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: ink),
                        ),
                      ),
                      ?trailing,
                    ],
                  ),
                ),
              child,
            ],
          ),
        ),
      ),
    );
  }
}

/// A label and its value on one row.
class KeyValue extends StatelessWidget {
  const KeyValue(this.label, this.value, {super.key, this.bold = false, this.color});
  final String label;
  final String value;
  final bool bold;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 5,
            child: Text(label, style: const TextStyle(color: muted)),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 6,
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: TextStyle(fontWeight: bold ? FontWeight.w800 : FontWeight.w600, color: color ?? ink),
            ),
          ),
        ],
      ),
    );
  }
}

/// A number tile on the dashboard.
class StatTile extends StatelessWidget {
  const StatTile({super.key, required this.label, required this.value, this.icon, this.color = brand, this.onTap});
  final String label;
  final String value;
  final IconData? icon;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  if (icon != null)
                    Container(
                      padding: const EdgeInsets.all(6),
                      decoration: BoxDecoration(color: color.withValues(alpha: .1), borderRadius: BorderRadius.circular(8)),
                      child: Icon(icon, size: 18, color: color),
                    ),
                  const Spacer(),
                  if (onTap != null) const Icon(Icons.chevron_right, size: 18, color: Color(0xFF98A2B3)),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                value,
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: ink),
              ),
              const SizedBox(height: 2),
              Text(
                label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, color: muted),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Tiles two to a row, each row as tall as its tallest tile.
class TilePairs extends StatelessWidget {
  const TilePairs({super.key, required this.tiles});
  final List<Widget> tiles;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (var i = 0; i < tiles.length; i += 2)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: tiles[i]),
                  const SizedBox(width: 10),
                  Expanded(child: i + 1 < tiles.length ? tiles[i + 1] : const SizedBox.shrink()),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// Parcel statuses by colour: done, problem, waiting, moving.
Color statusColor(String? status) {
  switch (status) {
    case 'DELIVERED':
    case 'PAID':
    case 'CONFIRMED':
    case 'COMPLETED':
      return good;
    case 'PICKUP_CANCELLED':
    case 'RETURNED':
    case 'RETURN_SCHEDULED':
    case 'EXCEPTION':
    case 'CANCELLED':
    case 'MISSED':
    case 'REJECTED':
    case 'VOID':
      return bad;
    case 'PENDING_CONFIRMATION':
    case 'RETRY_SCHEDULED':
    case 'REQUESTED':
    case 'ISSUED':
    case 'PARTIAL':
    case 'PENDING':
      return warn;
    default:
      return brand;
  }
}

/// "PICKUP_CANCELLED" → "Pickup cancelled" (when the API sends no label).
String humanize(String? s) {
  if (s == null || s.isEmpty) return '—';
  final t = s.replaceAll('_', ' ').toLowerCase();
  return t[0].toUpperCase() + t.substring(1);
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key, this.label});
  final String? status;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final c = statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: c.withValues(alpha: .1), borderRadius: BorderRadius.circular(20)),
      child: Text(
        label ?? humanize(status),
        style: TextStyle(color: c, fontSize: 12, fontWeight: FontWeight.w700),
      ),
    );
  }
}

/// The "AI" badge with a small sparkle at its corner (as on the web panels).
class AiBadge extends StatelessWidget {
  const AiBadge({super.key, this.size = 36});
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [Color(0xFF2F55C9), Color(0xFF6B8CF0)], begin: Alignment.topLeft, end: Alignment.bottomRight),
        borderRadius: BorderRadius.circular(10),
        boxShadow: const [BoxShadow(color: Color(0x302F55C9), blurRadius: 10, offset: Offset(0, 4))],
      ),
      child: const Stack(
        clipBehavior: Clip.none,
        children: [
          Text(
            'AI',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 14, height: 1),
          ),
          Positioned(top: -6, right: -9, child: Icon(Icons.auto_awesome, size: 9, color: Colors.white)),
        ],
      ),
    );
  }
}

/// A searchable list in a bottom sheet; returns the chosen item.
Future<String?> pickFromList(BuildContext context, {required String title, required List<String> items, String? selected, String Function(String)? labelOf}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => _PickSheet(title: title, items: items, selected: selected, labelOf: labelOf ?? (s) => s),
  );
}

class _PickSheet extends StatefulWidget {
  const _PickSheet({required this.title, required this.items, required this.selected, required this.labelOf});
  final String title;
  final List<String> items;
  final String? selected;
  final String Function(String) labelOf;

  @override
  State<_PickSheet> createState() => _PickSheetState();
}

class _PickSheetState extends State<_PickSheet> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final shown = widget.items.where((i) => widget.labelOf(i).toLowerCase().contains(_q.toLowerCase())).toList();
    return SizedBox(
      height: MediaQuery.of(context).size.height * .75,
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Column(
                children: [
                  Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                  const SizedBox(height: 10),
                  if (widget.items.length > 6)
                    TextField(
                      autofocus: false,
                      decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search', isDense: true),
                      onChanged: (v) => setState(() => _q = v),
                    ),
                ],
              ),
            ),
            Expanded(
              child: shown.isEmpty
                  ? const Center(
                      child: Text('Nothing matches', style: TextStyle(color: muted)),
                    )
                  : ListView.builder(
                      itemCount: shown.length,
                      itemBuilder: (_, i) => ListTile(
                        title: Text(widget.labelOf(shown[i])),
                        trailing: shown[i] == widget.selected ? const Icon(Icons.check, color: brand) : null,
                        onTap: () => Navigator.pop(context, shown[i]),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A form field that opens a picker (district, zone, product…).
class PickerField extends StatelessWidget {
  const PickerField({super.key, required this.label, required this.value, required this.onTap, this.errorText, this.icon});
  final String label;
  final String? value;
  final VoidCallback? onTap;
  final String? errorText;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: InputDecorator(
        isEmpty: value == null || value!.isEmpty,
        decoration: InputDecoration(labelText: label, errorText: errorText, prefixIcon: icon == null ? null : Icon(icon), suffixIcon: const Icon(Icons.arrow_drop_down), enabled: onTap != null),
        child: Text(value ?? '', maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
    );
  }
}

/// A full-width primary button with a spinner while busy.
class BusyButton extends StatelessWidget {
  const BusyButton({super.key, required this.label, required this.busy, required this.onPressed, this.icon});
  final String label;
  final bool busy;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      onPressed: busy ? null : onPressed,
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
      child: busy
          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4, color: Colors.white))
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon != null) ...[Icon(icon, size: 20), const SizedBox(width: 8)],
                Flexible(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                  ),
                ),
              ],
            ),
    );
  }
}

class ErrorBox extends StatelessWidget {
  const ErrorBox(this.message, {super.key});
  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFFEF3F2),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFFECDCA)),
      ),
      child: Text(message, style: const TextStyle(color: bad)),
    );
  }
}

Future<bool> confirm(BuildContext context, {required String title, required String message, String yes = 'Yes', bool danger = false}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('No')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: bad) : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(yes),
        ),
      ],
    ),
  );
  return ok ?? false;
}
