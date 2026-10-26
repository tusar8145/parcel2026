import 'dart:async';
import 'dart:convert';

import 'package:df_core/df_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Create order (E-commerce) / consignment (Banking & Financial), as on the merchant panels:
/// the optional "paste the customer's message" box (POST /parse-message) fills the empty fields; the full
/// address picks its district / zone / area (GET /catalog/place); the package's choices (service, pickup,
/// delivery, COD, open box, product) price the order live (POST /packages/quote). Returns the tracking ID.
class CreateOrderPage extends StatefulWidget {
  const CreateOrderPage({super.key});
  @override
  State<CreateOrderPage> createState() => _CreateOrderPageState();
}

class OrderSetup {
  OrderSetup(this.merchant, this.pkg, this.catalog);
  final Map<String, dynamic> merchant;
  final Map<String, dynamic> pkg;
  final Map<String, dynamic> catalog;
}

class _CreateOrderPageState extends State<CreateOrderPage> {
  late final Future<OrderSetup> _setup = _load();

  Future<OrderSetup> _load() async {
    final r = await Future.wait([Api.get('/merchants/me'), Api.get('/packages/me'), Api.get('/catalog')]);
    return OrderSetup(r[0] as Map<String, dynamic>, r[1] as Map<String, dynamic>, r[2] as Map<String, dynamic>);
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<OrderSetup>(
      future: _setup,
      builder: (context, snap) {
        final title = Session.isDocument ? 'New consignment' : 'New order';
        if (snap.connectionState != ConnectionState.done) {
          return Scaffold(
            appBar: AppBar(title: Text(title)),
            body: const Center(child: CircularProgressIndicator()),
          );
        }
        if (snap.hasError) {
          return Scaffold(
            appBar: AppBar(title: Text(title)),
            body: ErrorView(message: errorText(snap.error!)),
          );
        }
        return OrderForm(setup: snap.data!, title: title);
      },
    );
  }
}

class OrderForm extends StatefulWidget {
  const OrderForm({super.key, required this.setup, required this.title});
  final OrderSetup setup;
  final String title;
  @override
  State<OrderForm> createState() => _OrderFormState();
}

class _OrderFormState extends State<OrderForm> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _street = TextEditingController();
  final _weight = TextEditingController(text: '0.5');
  final _codAmount = TextEditingController();
  final _value = TextEditingController();
  final _ref = TextEditingController();
  final _contents = TextEditingController();
  final _instructions = TextEditingController();

  String? _district, _zone, _area;
  String _category = 'HOME';
  String? _product;
  bool _cod = true;
  bool _openBox = false;
  late String _speed;
  late String _firstMile;
  late String _lastMile;
  String? _dropHubId;
  String? _collectHubId;

  bool _placeLooking = false;
  String? _placeNote;
  Timer? _placeTimer;
  int _placeSeq = 0;

  Map<String, dynamic>? _quote;
  String? _quoteError;
  bool _quoting = false;
  Timer? _quoteTimer;
  int _quoteSeq = 0;

  bool _busy = false;
  String? _error;
  ({String json, String key})? _pending;

  Map<String, dynamic> get m => widget.setup.merchant;
  Map<String, dynamic> get pkg => widget.setup.pkg;
  Map<String, dynamic> get catalog => widget.setup.catalog;
  Map<String, dynamic> get opts => (pkg['options'] as Map<String, dynamic>?) ?? {};
  Map<String, dynamic> get labels => (pkg['labels'] as Map<String, dynamic>?) ?? {};
  bool get doc => Session.isDocument || pkg['segment'] == 'BANKING_FINANCIAL';
  bool get offersCod => !doc && opts['cod'] == true;
  bool get offersWeight => !doc && opts['weight'] != false;
  List<String> _list(String key) => ((opts[key] as List?) ?? []).map((e) => '$e').toList();
  String _label(String group, String code) => '${(labels[group] as Map?)?[code] ?? humanize(code)}';
  Map<String, dynamic> get _pickup => (m['pickup'] as Map<String, dynamic>?) ?? {};

  @override
  void initState() {
    super.initState();
    if (doc) _category = 'OFFICE';
    final speeds = _list('speeds');
    _speed = speeds.contains('REGULAR') || speeds.isEmpty ? 'REGULAR' : speeds.first;
    _firstMile = '${opts['defaultFirstMile'] ?? (_list('firstMiles').isEmpty ? 'RIDER_PICKUP' : _list('firstMiles').first)}';
    _lastMile = '${opts['defaultLastMile'] ?? (_list('lastMiles').isEmpty ? 'DOORSTEP' : _list('lastMiles').first)}';
    for (final c in [_weight, _codAmount]) {
      c.addListener(_requote);
    }
    _street.addListener(_addressChanged);
  }

  @override
  void dispose() {
    _placeTimer?.cancel();
    _quoteTimer?.cancel();
    super.dispose();
  }

  // ── places ──

  List<String> get _districts => ((catalog['districts'] as List?) ?? []).map((e) => '$e').toList();
  List<String> _zonesOf(String? d) => (((catalog['zonesByDistrict'] as Map?)?[d] as List?) ?? []).map((e) => '$e').toList();
  List<String> _areasOf(String? z) => (((catalog['areasByZone'] as Map?)?[z] as List?) ?? []).map((e) => '$e').toList();

  String _lastLooked = '';

  /// The typed address picks its district / zone / area (the merchant can still change them).
  void _addressChanged() {
    final text = _street.text.trim();
    if (text == _lastLooked) return;
    _placeTimer?.cancel();
    if (text.length < 4) return;
    _placeTimer = Timer(const Duration(milliseconds: 700), () => _lookUpPlace(text));
  }

  Future<void> _lookUpPlace(String text) async {
    _lastLooked = text;
    final seq = ++_placeSeq;
    setState(() => _placeLooking = true);
    try {
      final r = await Api.get('/catalog/place', {'address': text});
      if (seq != _placeSeq || !mounted) return;
      final d = r is Map ? r['district'] as String? : null;
      if (d != null && _districts.contains(d)) {
        setState(() {
          _district = d;
          final z = r['zone'] as String?;
          _zone = z != null && _zonesOf(d).contains(z) ? z : null;
          final a = r['area'] as String?;
          _area = a != null && _areasOf(_zone).contains(a) ? a : null;
          _placeNote = 'Picked from the address. Change them if they are wrong.';
        });
        _requote();
      } else {
        setState(() => _placeNote = _district == null ? 'Choose the district and zone below.' : null);
      }
    } catch (_) {
      // Picking the place is a help; the merchant chooses it by hand when it fails.
    } finally {
      if (seq == _placeSeq && mounted) setState(() => _placeLooking = false);
    }
  }

  Future<void> _pickDistrict() async {
    final v = await pickFromList(context, title: 'Delivery district', items: _districts, selected: _district);
    if (v == null || v == _district) return;
    setState(() {
      _district = v;
      _zone = null;
      _area = null;
      _placeNote = null;
    });
    _requote();
  }

  Future<void> _pickZone() async {
    final v = await pickFromList(context, title: 'Delivery zone', items: _zonesOf(_district), selected: _zone);
    if (v == null || v == _zone) return;
    setState(() {
      _zone = v;
      _area = null;
    });
    _requote();
  }

  Future<void> _pickArea() async {
    final v = await pickFromList(context, title: 'Delivery area', items: _areasOf(_zone), selected: _area);
    if (v == null) return;
    setState(() => _area = v);
    _requote();
  }

  // ── AI paste ──

  /// Puts what the message has into the EMPTY fields; returns the names of the fields it filled.
  List<String> _applyMessage(Map<String, dynamic> f) {
    final filled = <String>[];
    bool setIfEmpty(TextEditingController c, Object? v) {
      final s = '${v ?? ''}'.trim();
      if (s.isEmpty || c.text.trim().isNotEmpty) return false;
      c.text = s;
      return true;
    }

    if (setIfEmpty(_name, f['recipient_name'])) filled.add('name');
    final phone = '${f['recipient_phone'] ?? ''}'.replaceFirst(RegExp(r'^\+?880'), '0');
    if (setIfEmpty(_phone, phone)) filled.add('phone');
    final hadAddress = _street.text.trim().isNotEmpty;
    if (setIfEmpty(_street, f['address'])) filled.add('full address');
    // The message's place (matched to the catalog) when the form has none yet.
    final d = f['district'] as String?;
    if (!hadAddress && d != null && _districts.contains(d) && _district == null) {
      _placeTimer?.cancel();
      _lastLooked = _street.text.trim();
      _district = d;
      final z = f['zone'] as String?;
      _zone = z != null && _zonesOf(d).contains(z) ? z : null;
      final a = f['area'] as String?;
      _area = a != null && _areasOf(_zone).contains(a) ? a : null;
      _placeNote = 'Picked from the address. Change them if they are wrong.';
    }
    final cod = toNum(f['cod_amount']);
    if (offersCod && cod > 0 && _codAmount.text.trim().isEmpty) {
      _cod = true;
      _codAmount.text = cod == cod.roundToDouble() ? '${cod.round()}' : '$cod';
      filled.add('COD ${taka(cod)}');
    }
    final w = '${f['weight_kg'] ?? ''}'.trim();
    if (offersWeight && w.isNotEmpty && (_weight.text.trim().isEmpty || _weight.text.trim() == '0.5')) {
      _weight.text = w;
      filled.add('weight');
    }
    if (setIfEmpty(_ref, f['order_ref'])) filled.add('reference');
    if (setIfEmpty(_instructions, f['instructions'])) filled.add('note');
    setState(() {});
    _requote();
    return filled;
  }

  // ── price ──

  Map<String, dynamic> _choices() => {
    'firstMile': _firstMile,
    if (_firstMile == 'HUB_DROP' && _dropHubId != null) 'dropHubId': _dropHubId,
    'lastMile': _lastMile,
    if (_lastMile == 'HUB_COLLECT' && _collectHubId != null) 'collectHubId': _collectHubId,
    'speed': _speed,
    if (_product != null) 'product': _product,
    'openBox': opts['openBox'] == true && _openBox,
  };

  num get _codValue => offersCod && _cod ? toNum(_codAmount.text.trim()) : 0;
  num get _weightValue => offersWeight ? (num.tryParse(_weight.text.trim()) ?? 0.5) : 0.5;

  void _requote() {
    _quoteTimer?.cancel();
    _quoteTimer = Timer(const Duration(milliseconds: 350), _fetchQuote);
  }

  Future<void> _fetchQuote() async {
    if (_district == null) {
      setState(() {
        _quote = null;
        _quoteError = null;
      });
      return;
    }
    final seq = ++_quoteSeq;
    setState(() => _quoting = true);
    try {
      final q = await Api.post('/packages/quote', {
        'pickupDistrict': _pickup['district'] ?? m['pickupDistrict'],
        if (_pickup['zone'] != null) 'pickupZone': _pickup['zone'],
        if (_pickup['area'] != null) 'pickupArea': _pickup['area'],
        'deliveryDistrict': _district,
        'deliveryZone': ?_zone,
        'deliveryArea': ?_area,
        if (offersWeight && _weightValue > 0 && _weightValue <= 50) 'weightKg': _weightValue,
        'codAmount': _codValue,
        ..._choices(),
      });
      if (seq != _quoteSeq || !mounted) return;
      setState(() {
        _quote = q;
        _quoteError = null;
      });
    } catch (e) {
      if (seq != _quoteSeq || !mounted) return;
      setState(() {
        _quote = null;
        _quoteError = e is ApiError && e.status == 422 ? e.message : 'The charge is confirmed when you create the order.';
      });
    } finally {
      if (seq == _quoteSeq && mounted) setState(() => _quoting = false);
    }
  }

  // ── submit ──

  Map<String, dynamic> _body() {
    final p = _pickup;
    return {
      ..._choices(),
      'sender': {'name': m['name'], 'phone': m['pickupContactPhone'] ?? m['contactPhone']},
      'pickup': {
        'category': 'OFFICE',
        'street': p['street'] ?? m['pickupAddress'],
        'area': ?p['area'],
        'zone': p['zone'],
        'district': p['district'] ?? m['pickupDistrict'],
        if (p['lat'] != null && p['lng'] != null) 'lat': p['lat'],
        if (p['lat'] != null && p['lng'] != null) 'lng': p['lng'],
      },
      'recipient': {'name': _name.text.trim(), 'phone': normalizePhone(_phone.text)},
      'delivery': {'category': _category, 'street': _street.text.trim(), 'area': ?_area, 'zone': _zone, 'district': _district},
      'type': doc ? 'DOCUMENT' : 'ECOMMERCE',
      // Banking & Financial has no weight in pricing: the API needs one, 0.5 kg (the included weight).
      'weightKg': _weightValue,
      if (toNum(_value.text) > 0) 'declaredValue': toNum(_value.text),
      'codAmount': _codValue,
      if (_ref.text.trim().isNotEmpty) 'merchantOrderRef': _ref.text.trim(),
      if (_contents.text.trim().isNotEmpty) 'contents': _contents.text.trim(),
      if (_instructions.text.trim().isNotEmpty) 'instructions': _instructions.text.trim(),
      'saveAddresses': false,
    };
  }

  bool _tried = false;

  Future<void> _submit() async {
    setState(() {
      _tried = true;
      _error = null;
    });
    final ok = _form.currentState!.validate();
    if (!ok || _district == null || _zone == null || (_firstMile == 'HUB_DROP' && _dropHubId == null)) {
      snack(context, 'Check the highlighted fields.');
      return;
    }
    if (_pickup['zone'] == null && m['pickupDistrict'] == null) {
      setState(() => _error = 'Your pickup address is incomplete. Complete it on the merchant panel (Settings) first.');
      return;
    }
    final body = _body();
    final json = jsonEncode(body);
    if (_pending == null || _pending!.json != json) _pending = (json: json, key: Api.newKey());
    setState(() => _busy = true);
    try {
      final parcel = await Api.post('/parcels', body, headers: {'Idempotency-Key': _pending!.key});
      _pending = null;
      if (!mounted) return;
      snack(context, '${doc ? 'Consignment' : 'Order'} ${parcel['trackingId']} booked.');
      Navigator.of(context).pop('${parcel['trackingId']}');
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // ── layout ──

  Widget _gap([double h = 12]) => SizedBox(height: h);

  Widget _chips(String title, List<String> codes, String selected, String group, ValueChanged<String> onPick) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(fontWeight: FontWeight.w600, color: Color(0xFF475467)),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 8,
          runSpacing: 6,
          children: [
            for (final c in codes)
              ChoiceChip(
                label: Text(_label(group, c)),
                selected: c == selected,
                onSelected: (_) {
                  onPick(c);
                  _requote();
                },
              ),
          ],
        ),
      ],
    );
  }

  List<Map<String, dynamic>> _hubs(String key) => ((pkg[key] as List?) ?? []).cast<Map<String, dynamic>>();

  Future<void> _pickHub(String key, String title, String? selected, ValueChanged<String> onPick) async {
    final hubs = _hubs(key);
    final v = await pickFromList(
      context,
      title: title,
      items: hubs.map((h) => '${h['id']}').toList(),
      selected: selected,
      labelOf: (id) {
        final h = hubs.firstWhere((h) => h['id'] == id);
        return '${h['name']} · ${h['district'] ?? ''}';
      },
    );
    if (v == null) return;
    setState(() => onPick(v));
    _requote();
  }

  String? _hubName(String key, String? id) {
    if (id == null) return null;
    for (final h in _hubs(key)) {
      if (h['id'] == id) return '${h['name']}';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final products = ((pkg['products'] as List?) ?? []).cast<Map<String, dynamic>>();
    final speeds = _list('speeds');
    final firstMiles = _list('firstMiles');
    final lastMiles = _list('lastMiles');
    final total = _quote?['totalCharge'];
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, style: const TextStyle(fontWeight: FontWeight.w800)),
      ),
      body: Form(
        key: _form,
        autovalidateMode: _tried ? AutovalidateMode.onUserInteraction : AutovalidateMode.disabled,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
          children: [
            PasteMessageBox(kind: doc ? 'document' : 'ecommerce', onFill: _applyMessage),
            _gap(),
            Panel(
              title: 'Recipient',
              child: Column(
                children: [
                  TextFormField(
                    controller: _name,
                    textCapitalization: TextCapitalization.words,
                    textInputAction: TextInputAction.next,
                    decoration: InputDecoration(labelText: doc ? 'Recipient name or office' : 'Customer name', prefixIcon: const Icon(Icons.person_outline)),
                    validator: (v) => (v?.trim().length ?? 0) < 2 ? 'Enter the recipient\'s name' : null,
                  ),
                  _gap(),
                  TextFormField(
                    controller: _phone,
                    keyboardType: TextInputType.phone,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(labelText: 'Mobile number', hintText: '01XXXXXXXXX', prefixIcon: Icon(Icons.phone_iphone)),
                    validator: phoneError,
                  ),
                  _gap(),
                  TextFormField(
                    controller: _street,
                    minLines: 2,
                    maxLines: 4,
                    maxLength: 200,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: InputDecoration(
                      labelText: 'Full address',
                      hintText: 'House, road, area, city — as the customer wrote it',
                      alignLabelWithHint: true,
                      prefixIcon: const Icon(Icons.home_outlined),
                      suffixIcon: _placeLooking
                          ? const Padding(
                              padding: EdgeInsets.all(14),
                              child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                            )
                          : null,
                    ),
                    validator: (v) => (v?.trim().length ?? 0) < 6 ? 'Enter the full address' : null,
                  ),
                  if (_placeNote != null)
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Text(_placeNote!, style: const TextStyle(fontSize: 12.5, color: muted)),
                    ),
                  _gap(8),
                  PickerField(label: 'District', value: _district, onTap: _pickDistrict, errorText: _tried && _district == null ? 'Choose the district' : null, icon: Icons.map_outlined),
                  _gap(),
                  Row(
                    children: [
                      Expanded(
                        child: PickerField(label: 'Zone', value: _zone, onTap: _district == null ? null : _pickZone, errorText: _tried && _zone == null ? 'Choose the zone' : null),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: PickerField(label: 'Area (optional)', value: _area, onTap: _areasOf(_zone).isEmpty ? null : _pickArea),
                      ),
                    ],
                  ),
                  _gap(),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Wrap(
                      spacing: 8,
                      children: [
                        for (final c in const ['HOME', 'OFFICE', 'OTHER']) ChoiceChip(label: Text(humanize(c)), selected: _category == c, onSelected: (_) => setState(() => _category = c)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Panel(
              title: doc ? 'Consignment' : 'Parcel',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (products.isNotEmpty) ...[
                    PickerField(
                      label: 'Product (optional)',
                      value: _product,
                      icon: Icons.category_outlined,
                      onTap: () async {
                        final v = await pickFromList(
                          context,
                          title: 'Product',
                          items: ['', ...products.map((p) => '${p['name']}')],
                          selected: _product ?? '',
                          labelOf: (s) {
                            if (s.isEmpty) return 'None (Regular)';
                            final p = products.firstWhere((p) => p['name'] == s);
                            return '$s · ${_label('productType', '${p['type']}')}';
                          },
                        );
                        if (v == null) return;
                        setState(() => _product = v.isEmpty ? null : v);
                        _requote();
                      },
                    ),
                    _gap(),
                  ],
                  if (offersWeight) ...[
                    TextFormField(
                      controller: _weight,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: const InputDecoration(labelText: 'Weight', suffixText: 'kg', prefixIcon: Icon(Icons.scale_outlined)),
                      validator: (v) {
                        final n = num.tryParse(v?.trim() ?? '');
                        if (n == null || n <= 0) return 'Enter the weight';
                        return n > 50 ? 'At most 50 kg' : null;
                      },
                    ),
                    _gap(),
                  ],
                  if (offersCod) ...[
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Collect cash on delivery (COD)', style: TextStyle(fontWeight: FontWeight.w600)),
                      value: _cod,
                      onChanged: (v) {
                        setState(() => _cod = v);
                        _requote();
                      },
                    ),
                    if (_cod)
                      TextFormField(
                        controller: _codAmount,
                        keyboardType: TextInputType.number,
                        decoration: const InputDecoration(labelText: 'Cash to collect', prefixText: '৳ ', prefixIcon: Icon(Icons.payments_outlined)),
                        validator: (v) {
                          if (!_cod) return null;
                          final n = num.tryParse(v?.trim() ?? '');
                          if (v == null || v.trim().isEmpty) return 'Enter the cash to collect, or turn COD off';
                          if (n == null || n < 1) return 'Enter an amount of at least ৳1';
                          return n > 1000000 ? 'The amount is too large' : null;
                        },
                      ),
                    _gap(),
                  ],
                  if (!doc) ...[
                    TextFormField(
                      controller: _value,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(labelText: 'Product value (optional)', prefixText: '৳ '),
                    ),
                    _gap(),
                  ],
                  if (opts['openBox'] == true && !doc)
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: const Text('Open box (customer may check before paying)'),
                      value: _openBox,
                      onChanged: (v) {
                        setState(() => _openBox = v);
                        _requote();
                      },
                    ),
                  TextFormField(
                    controller: _ref,
                    decoration: InputDecoration(labelText: doc ? 'Reference no. (optional)' : 'Order / invoice no. (optional)', prefixIcon: const Icon(Icons.tag)),
                  ),
                  _gap(),
                  TextFormField(
                    controller: _contents,
                    maxLength: 120,
                    decoration: InputDecoration(labelText: doc ? 'Documents (optional)' : 'Contents (optional)', hintText: doc ? 'e.g. Cheque book, card' : 'e.g. 2 shirts', counterText: ''),
                  ),
                  _gap(),
                  TextFormField(
                    controller: _instructions,
                    maxLength: 500,
                    minLines: 1,
                    maxLines: 3,
                    decoration: const InputDecoration(labelText: 'Note for the rider (optional)', counterText: ''),
                  ),
                ],
              ),
            ),
            Panel(
              title: 'Service',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (speeds.length > 1) ...[_chips('Service', speeds, _speed, 'speed', (c) => setState(() => _speed = c)), _gap()],
                  if (firstMiles.length > 1) ...[_chips('Pickup', firstMiles, _firstMile, 'firstMile', (c) => setState(() => _firstMile = c)), _gap()],
                  if (_firstMile == 'HUB_DROP') ...[
                    PickerField(
                      label: 'Hub you bring it to',
                      value: _hubName('dropHubs', _dropHubId),
                      errorText: _tried && _dropHubId == null ? 'Choose the hub' : null,
                      onTap: () => _pickHub('dropHubs', 'Drop-off hub', _dropHubId, (v) => _dropHubId = v),
                    ),
                    _gap(),
                  ],
                  if (lastMiles.length > 1) ...[_chips('Delivery', lastMiles, _lastMile, 'lastMile', (c) => setState(() => _lastMile = c)), _gap()],
                  if (_lastMile == 'HUB_COLLECT' && _hubs('collectHubs').isNotEmpty)
                    PickerField(
                      label: 'Collection hub (default: nearest)',
                      value: _hubName('collectHubs', _collectHubId),
                      onTap: () => _pickHub('collectHubs', 'Collection hub', _collectHubId, (v) => _collectHubId = v),
                    ),
                  Text('Pickup from: ${_pickup['street'] ?? m['pickupAddress'] ?? '—'}', style: const TextStyle(fontSize: 12.5, color: muted)),
                ],
              ),
            ),
            _PriceBox(quote: _quote, error: _quoteError, loading: _quoting, needsPlace: _district == null),
            if (_error != null) ...[ErrorBox(_error!), _gap()],
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          decoration: const BoxDecoration(
            color: Colors.white,
            border: Border(top: BorderSide(color: line)),
          ),
          child: Row(
            children: [
              Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Delivery charge', style: TextStyle(fontSize: 12, color: muted)),
                  Text(total == null ? '—' : taka(total), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                ],
              ),
              const SizedBox(width: 16),
              Expanded(
                child: BusyButton(label: doc ? 'Book consignment' : 'Create order', busy: _busy, onPressed: _submit),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PriceBox extends StatelessWidget {
  const _PriceBox({required this.quote, required this.error, required this.loading, required this.needsPlace});
  final Map<String, dynamic>? quote;
  final String? error;
  final bool loading;
  final bool needsPlace;

  @override
  Widget build(BuildContext context) {
    final q = quote;
    return Panel(
      title: 'Price',
      trailing: loading ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : null,
      child: needsPlace
          ? const Text('Choose the delivery district to see the price from your service package.', style: TextStyle(color: muted))
          : q == null
          ? Text(error ?? 'Working out the price…', style: TextStyle(color: error != null ? warn : muted))
          : Column(
              children: [
                for (final l in ((q['lines'] as List?) ?? []).cast<Map>()) KeyValue('${l['label']}', taka(l['amount'])),
                if (toNum(q['discount']) > 0) KeyValue('Discount', '-${taka(q['discount'])}', color: good),
                const Divider(),
                KeyValue('Total charge', taka(q['totalCharge']), bold: true),
                if (toNum(q['codAmount']) > 0) KeyValue('You receive (COD − charge)', taka(toNum(q['codAmount']) - toNum(q['totalCharge'])), color: good),
                if (q['returnCharge'] != null) KeyValue('If returned', taka(q['returnCharge'])),
              ],
            ),
    );
  }
}

/// "Got the customer's details in a message? Paste it": the text (SMS, chat, another platform's message,
/// English or Bangla) is read by POST /parse-message and [onFill] puts it into the form's empty fields.
class PasteMessageBox extends StatefulWidget {
  const PasteMessageBox({super.key, required this.kind, required this.onFill, this.initiallyOpen = true});
  final String kind;
  final List<String> Function(Map<String, dynamic> fields) onFill;
  final bool initiallyOpen;
  @override
  State<PasteMessageBox> createState() => _PasteMessageBoxState();
}

class _PasteMessageBoxState extends State<PasteMessageBox> {
  late bool _open = widget.initiallyOpen;
  final _text = TextEditingController();
  bool _busy = false;
  ({bool ok, String text})? _note;

  Future<void> _pasteFromClipboard() async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final t = data?.text?.trim() ?? '';
    if (t.isEmpty) {
      if (mounted) snack(context, 'Nothing to paste. Copy the message first.');
      return;
    }
    _text.text = t;
    await _read();
  }

  Future<void> _read() async {
    final text = _text.text.trim();
    if (text.length < 5) {
      setState(() => _note = (ok: false, text: 'Paste the message first.'));
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      final r = await Api.post('/parse-message', {'text': text.length > 3000 ? text.substring(0, 3000) : text, 'kind': widget.kind});
      final fields = (r['fields'] as Map?)?.cast<String, dynamic>() ?? {};
      final filled = widget.onFill(fields);
      setState(
        () => _note = filled.isNotEmpty
            ? (ok: true, text: 'Filled: ${filled.join(', ')}. Check them; district, zone and area follow the address. Fill in anything still empty.')
            : (ok: false, text: fields.isNotEmpty ? 'Those fields already have values; nothing was changed.' : 'No name, phone or address found in that message. Please fill in the form.'),
      );
    } catch (e) {
      setState(() => _note = (ok: false, text: errorText(e)));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFFF7F9FF),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFFB9C7E6)),
      ),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Row(
              children: [
                const AiBadge(),
                const SizedBox(width: 12),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        "Got the customer's details in a message? Paste it",
                        style: TextStyle(fontWeight: FontWeight.w800, color: ink),
                      ),
                      SizedBox(height: 2),
                      Text('Optional · we fill the name, phone, address and amount from it (English or বাংলা)', style: TextStyle(fontSize: 12.5, color: Color(0xFF5D6B80))),
                    ],
                  ),
                ),
                Icon(_open ? Icons.expand_less : Icons.expand_more, color: muted),
              ],
            ),
          ),
          if (_open) ...[
            const SizedBox(height: 10),
            TextField(
              controller: _text,
              minLines: 4,
              maxLines: 8,
              maxLength: 3000,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(hintText: 'e.g.\nName: Ayesha Rahman\nPhone: 01712345678\nAddress: House 12, Road 5, Dhanmondi, Dhaka\nCOD: 1250', counterText: ''),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _busy ? null : _read,
                    icon: _busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.auto_awesome, size: 18),
                    label: Text(_busy ? 'Reading…' : 'Fill the form'),
                  ),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(onPressed: _busy ? null : _pasteFromClipboard, icon: const Icon(Icons.content_paste, size: 18), label: const Text('Paste')),
                if (_text.text.isNotEmpty || _note != null)
                  IconButton(
                    tooltip: 'Clear',
                    onPressed: () => setState(() {
                      _text.clear();
                      _note = null;
                    }),
                    icon: const Icon(Icons.close),
                  ),
              ],
            ),
            if (_note != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_note!.text, style: TextStyle(fontSize: 13, color: _note!.ok ? good : const Color(0xFF9A3412))),
              ),
          ],
        ],
      ),
    );
  }
}
