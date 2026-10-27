import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import 'api.dart';
import 'branding.dart';
import 'widgets.dart';

/// The categories requesters choose (as the web's support form).
const ticketCategories = ['Delivery issue', 'Pickup or collection', 'COD / payment', 'Account / API', 'Rider or safety', 'Other'];

/// A photo attached to a request or reply ({ filename, dataUrl }, as POST /support/tickets takes it).
class _Photo {
  _Photo(this.name, this.bytes);
  final String name;
  final List<int> bytes;
  Map<String, String> get json => {'filename': name, 'dataUrl': 'data:image/jpeg;base64,${base64Encode(bytes)}'};
}

/// Takes a photo (camera or gallery), resized and compressed so it stays well under the 5 MB limit.
Future<_Photo?> _pickPhoto(BuildContext context) async {
  final source = await showModalBottomSheet<ImageSource>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(leading: const Icon(Icons.photo_camera_outlined), title: const Text('Take a photo'), onTap: () => Navigator.pop(context, ImageSource.camera)),
          ListTile(leading: const Icon(Icons.photo_library_outlined), title: const Text('Choose from gallery'), onTap: () => Navigator.pop(context, ImageSource.gallery)),
        ],
      ),
    ),
  );
  if (source == null) return null;
  final file = await ImagePicker().pickImage(source: source, maxWidth: 1600, maxHeight: 1600, imageQuality: 70);
  if (file == null) return null;
  final bytes = await file.readAsBytes();
  return _Photo(file.name.isEmpty ? 'photo.jpg' : file.name, bytes);
}

/// Support: the user's requests (newest first) and "New request".
class SupportPage extends StatefulWidget {
  const SupportPage({super.key});
  @override
  State<SupportPage> createState() => _SupportPageState();
}

class _SupportPageState extends State<SupportPage> {
  final _loader = GlobalKey<LoaderState<List<Map<String, dynamic>>>>();

  Future<void> _new() async {
    final number = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const NewTicketPage()));
    _loader.currentState?.reload();
    if (number != null && mounted) Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketPage(number: number)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Support', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      floatingActionButton: FloatingActionButton.extended(heroTag: 'support', onPressed: _new, icon: const Icon(Icons.add_comment_outlined), label: const Text('New request')),
      body: Loader<List<Map<String, dynamic>>>(
        key: _loader,
        load: () async => (((await Api.get('/support/tickets', {'limit': 50}))['items'] as List?) ?? []).cast<Map<String, dynamic>>(),
        builder: (context, items, reload) => RefreshIndicator(
          onRefresh: reload,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
            children: [
              const Panel(
                child: Row(
                  children: [
                    Icon(Icons.support_agent, color: brand, size: 30),
                    SizedBox(width: 12),
                    Expanded(
                      child: Text('Tell us about a problem with a parcel, a payment or your account. Our team replies here and you get a notification.', style: TextStyle(color: muted)),
                    ),
                  ],
                ),
              ),
              // The company's phone and email (Super admin › Branding & company), when it has them.
              BrandingBuilder(
                builder: (context) {
                  final phone = '${Branding.contact['phone'] ?? ''}'.trim();
                  final email = '${Branding.contact['email'] ?? ''}'.trim();
                  if (phone.isEmpty && email.isEmpty) return const SizedBox.shrink();
                  return Panel(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(Branding.nameOr('Contact us'), style: const TextStyle(fontWeight: FontWeight.w800)),
                        if (phone.isNotEmpty) ...[const SizedBox(height: 8), Row(children: [const Icon(Icons.call_outlined, size: 18, color: muted), const SizedBox(width: 8), SelectableText(phone)])],
                        if (email.isNotEmpty) ...[const SizedBox(height: 6), Row(children: [const Icon(Icons.mail_outline, size: 18, color: muted), const SizedBox(width: 8), Expanded(child: SelectableText(email))])],
                      ],
                    ),
                  );
                },
              ),
              if (items.isEmpty) const EmptyView(icon: Icons.forum_outlined, text: 'No requests yet.'),
              for (final t in items)
                Panel(
                  padding: EdgeInsets.zero,
                  child: ListTile(
                    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                    onTap: () async {
                      await Navigator.of(context).push(MaterialPageRoute(builder: (_) => TicketPage(number: '${t['number']}')));
                      _loader.currentState?.reload();
                    },
                    title: Text('${t['subject'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const SizedBox(height: 4),
                        Text('${t['number']} · ${t['category']}', style: const TextStyle(fontSize: 12.5, color: muted)),
                        if ((t['lastMessage'] as Map?)?['preview'] != null) Text('${(t['lastMessage'] as Map)['preview']}', maxLines: 1, overflow: TextOverflow.ellipsis),
                        Text(dateTimeText(t['updatedAt']), style: const TextStyle(fontSize: 12, color: muted)),
                      ],
                    ),
                    trailing: StatusChip(_ticketColorKey(t['status'] as String?), label: '${t['statusLabel'] ?? humanize(t['status'] as String?)}'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Ticket statuses on the shared status colours.
String _ticketColorKey(String? s) => switch (s) {
  'RESOLVED' || 'CLOSED' => 'COMPLETED',
  'WAITING_FOR_REQUESTER' => 'PENDING',
  _ => 'IN_TRANSIT',
};

/// New support request; [relatedRef] (a tracking ID) when opened from a parcel. Returns the ticket number.
class NewTicketPage extends StatefulWidget {
  const NewTicketPage({super.key, this.relatedRef, this.category, this.subject});
  final String? relatedRef;
  final String? category;
  final String? subject;
  @override
  State<NewTicketPage> createState() => _NewTicketPageState();
}

class _NewTicketPageState extends State<NewTicketPage> {
  final _form = GlobalKey<FormState>();
  late String _category = widget.category ?? ticketCategories.first;
  late final _subject = TextEditingController(text: widget.subject ?? '');
  late final _ref = TextEditingController(text: widget.relatedRef ?? '');
  final _message = TextEditingController();
  final List<_Photo> _photos = [];
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final t = await Api.post('/support/tickets', {
        'category': _category,
        'subject': _subject.text.trim(),
        'message': _message.text.trim(),
        if (_ref.text.trim().isNotEmpty) 'relatedRef': _ref.text.trim().toUpperCase(),
        'attachments': [for (final p in _photos) p.json],
      });
      if (!mounted) return;
      snack(context, 'Request ${t['number']} sent. We will reply here.');
      Navigator.of(context).pop('${t['number']}');
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('New request', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text('What is it about?', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [for (final c in ticketCategories) ChoiceChip(label: Text(c), selected: _category == c, onSelected: (_) => setState(() => _category = c))],
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _subject,
              maxLength: 120,
              decoration: const InputDecoration(labelText: 'Subject', counterText: ''),
              validator: (v) => (v?.trim().length ?? 0) < 3 ? 'Write a short subject (at least 3 characters)' : null,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _ref,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Tracking ID (optional)', prefixIcon: Icon(Icons.tag)),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _message,
              minLines: 4,
              maxLines: 8,
              maxLength: 3000,
              decoration: const InputDecoration(labelText: 'Message', alignLabelWithHint: true),
              validator: (v) => (v?.trim().isEmpty ?? true) ? 'Write a message' : null,
            ),
            _PhotoRow(photos: _photos, onChanged: () => setState(() {})),
            if (_error != null) ...[const SizedBox(height: 12), ErrorBox(_error!)],
            const SizedBox(height: 16),
            BusyButton(label: 'Send request', busy: _busy, onPressed: _submit, icon: Icons.send),
          ],
        ),
      ),
    );
  }
}

/// Up to 5 attached photos with "Add photo".
class _PhotoRow extends StatelessWidget {
  const _PhotoRow({required this.photos, required this.onChanged});
  final List<_Photo> photos;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (final p in photos)
          InputChip(
            avatar: const Icon(Icons.image_outlined, size: 18),
            label: Text(p.name, overflow: TextOverflow.ellipsis),
            onDeleted: () {
              photos.remove(p);
              onChanged();
            },
          ),
        if (photos.length < 5)
          TextButton.icon(
            onPressed: () async {
              final p = await _pickPhoto(context);
              if (p == null) return;
              photos.add(p);
              onChanged();
            },
            icon: const Icon(Icons.add_a_photo_outlined),
            label: const Text('Add photo'),
          ),
      ],
    );
  }
}

/// One request: the conversation and a reply box.
class TicketPage extends StatefulWidget {
  const TicketPage({super.key, required this.number});
  final String number;
  @override
  State<TicketPage> createState() => _TicketPageState();
}

class _TicketPageState extends State<TicketPage> {
  final _loader = GlobalKey<LoaderState<Map<String, dynamic>>>();
  final _reply = TextEditingController();
  final List<_Photo> _photos = [];
  bool _busy = false;

  Future<void> _send() async {
    if (_reply.text.trim().isEmpty) return;
    setState(() => _busy = true);
    try {
      await Api.post('/support/tickets/${Uri.encodeComponent(widget.number)}/messages', {
        'body': _reply.text.trim(),
        'attachments': [for (final p in _photos) p.json],
      });
      _reply.clear();
      _photos.clear();
      FocusManager.instance.primaryFocus?.unfocus();
      await _loader.currentState?.reload();
    } catch (e) {
      if (mounted) snack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final origin = Uri.parse(apiBase).origin;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.number, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
      ),
      body: Loader<Map<String, dynamic>>(
        key: _loader,
        load: () async => await Api.get('/support/tickets/${Uri.encodeComponent(widget.number)}') as Map<String, dynamic>,
        builder: (context, t, reload) {
          final messages = ((t['messages'] as List?) ?? []).cast<Map<String, dynamic>>().where((m) => m['internal'] != true).toList();
          return Column(
            children: [
              Container(
                width: double.infinity,
                color: Colors.white,
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('${t['subject'] ?? ''}', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        StatusChip(_ticketColorKey(t['status'] as String?), label: '${t['statusLabel'] ?? humanize(t['status'] as String?)}'),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            [t['category'], if (t['relatedRef'] != null) t['relatedRef']].join(' · '),
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: muted, fontSize: 12.5),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              Expanded(
                child: RefreshIndicator(
                  onRefresh: reload,
                  child: ListView(
                    padding: const EdgeInsets.all(14),
                    children: [for (final m in messages) _Bubble(message: m, origin: origin)],
                  ),
                ),
              ),
              SafeArea(
                top: false,
                child: Container(
                  color: Colors.white,
                  padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_photos.isNotEmpty)
                        Align(
                          alignment: Alignment.centerLeft,
                          child: _PhotoRow(photos: _photos, onChanged: () => setState(() {})),
                        ),
                      Row(
                        children: [
                          IconButton(
                            tooltip: 'Attach a photo',
                            onPressed: _photos.length >= 5
                                ? null
                                : () async {
                                    final p = await _pickPhoto(context);
                                    if (p != null) setState(() => _photos.add(p));
                                  },
                            icon: const Icon(Icons.attach_file),
                          ),
                          Expanded(
                            child: TextField(
                              controller: _reply,
                              minLines: 1,
                              maxLines: 4,
                              maxLength: 3000,
                              decoration: const InputDecoration(hintText: 'Write a reply', isDense: true, counterText: ''),
                            ),
                          ),
                          const SizedBox(width: 6),
                          IconButton.filled(
                            onPressed: _busy ? null : _send,
                            icon: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.send),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message, required this.origin});
  final Map<String, dynamic> message;
  final String origin;

  @override
  Widget build(BuildContext context) {
    final mine = (message['author'] as Map?)?['kind'] == 'requester';
    final files = ((message['attachments'] as List?) ?? []).cast<Map<String, dynamic>>();
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * .8),
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: mine ? const Color(0xFFE8EEFF) : Colors.white,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: mine ? const Color(0xFFCCD7FA) : line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                mine ? 'You' : '${(message['author'] as Map?)?['label'] ?? Branding.nameOr('Support')}',
                style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12.5, color: muted),
              ),
              const SizedBox(height: 4),
              SelectableText('${message['body'] ?? ''}'),
              for (final f in files)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: '${f['mimeType']}'.startsWith('image/')
                      ? ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: Image.network(
                            '$origin${f['url']}',
                            headers: {if (Session.accessToken != null) 'authorization': 'Bearer ${Session.accessToken}'},
                            height: 160,
                            fit: BoxFit.cover,
                            errorBuilder: (_, _, _) => Text('📎 ${f['filename']}'),
                          ),
                        )
                      : Text('📎 ${f['filename']}', style: const TextStyle(color: brand)),
                ),
              const SizedBox(height: 4),
              Text(dateTimeText(message['createdAt']), style: const TextStyle(fontSize: 11.5, color: muted)),
            ],
          ),
        ),
      ),
    );
  }
}
