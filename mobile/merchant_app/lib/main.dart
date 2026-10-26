import 'package:flutter/material.dart';

import 'api.dart';
import 'home.dart';
import 'widgets.dart';

/// Delivery Fast Merchant: E-commerce and Banking & Financial merchants on one app (it adapts to the
/// signed-in merchant's type). Phase 1: orders, pickups, balance, notifications and profile.
void main() {
  onSignedOut = () => navigatorKey.currentState?.pushAndRemoveUntil(MaterialPageRoute(builder: (_) => const LoginPage()), (_) => false);
  runApp(const MerchantApp());
}

class MerchantApp extends StatelessWidget {
  const MerchantApp({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(seedColor: brand, primary: brand, surface: Colors.white);
    return MaterialApp(
      title: 'Delivery Fast Merchant',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: scheme,
        useMaterial3: true,
        scaffoldBackgroundColor: page,
        appBarTheme: const AppBarTheme(backgroundColor: Colors.white, foregroundColor: ink, surfaceTintColor: Colors.white, elevation: 0, scrolledUnderElevation: 1),
        inputDecorationTheme: InputDecorationTheme(
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(10)),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: Color(0xFFD0D5DD)),
          ),
          filled: true,
          fillColor: Colors.white,
        ),
      ),
      home: const StartPage(),
    );
  }
}

/// Opens the home page when a saved session is still valid, else the sign-in page.
class StartPage extends StatefulWidget {
  const StartPage({super.key});
  @override
  State<StartPage> createState() => _StartPageState();
}

class _StartPageState extends State<StartPage> {
  @override
  void initState() {
    super.initState();
    Session.restore().then((ok) {
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => ok ? const HomeShell() : const LoginPage()));
    });
  }

  @override
  Widget build(BuildContext context) => const Scaffold(body: Center(child: CircularProgressIndicator()));
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _form = GlobalKey<FormState>();
  final _identity = TextEditingController();
  final _password = TextEditingController();
  bool _hidden = true;
  bool _busy = false;
  String? _error;

  /// Phone numbers as the API takes them: 1XXXXXXXXX, 01XXXXXXXXX or +8801… (emails as typed).
  String _identifier() {
    final v = _identity.text.trim();
    return v.contains('@') ? v : normalizePhone(v);
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final body = await Api.post('/auth/login', {'identifier': _identifier(), 'password': _password.text}, retry: false);
      if (body['accessToken'] == null) throw ApiError('This account needs two-step verification; sign in on the website.');
      await Session.save(body);
      if (!Session.isMerchant) {
        await Session.logout();
        throw ApiError('This app is for merchants. Your account is not a merchant account.');
      }
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeShell()));
    } on ApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _form,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const BrandMark(),
                    const SizedBox(height: 28),
                    Text('Merchant sign in', style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 6),
                    const Text('Use the phone number (or email) and password of your merchant account.', style: TextStyle(color: muted)),
                    const SizedBox(height: 22),
                    TextFormField(
                      controller: _identity,
                      keyboardType: TextInputType.emailAddress,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.telephoneNumber, AutofillHints.email],
                      decoration: const InputDecoration(labelText: 'Phone or email', hintText: '01XXXXXXXXX', prefixIcon: Icon(Icons.person_outline)),
                      validator: (v) {
                        final t = v?.trim() ?? '';
                        if (t.isEmpty) return 'Enter your phone number or email';
                        if (!t.contains('@') && !isBdMobile(t)) return 'Enter a Bangladeshi mobile number (01XXXXXXXXX)';
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),
                    TextFormField(
                      controller: _password,
                      obscureText: _hidden,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      autofillHints: const [AutofillHints.password],
                      decoration: InputDecoration(
                        labelText: 'Password',
                        prefixIcon: const Icon(Icons.lock_outline),
                        suffixIcon: IconButton(
                          icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                          onPressed: () => setState(() => _hidden = !_hidden),
                          tooltip: _hidden ? 'Show password' : 'Hide password',
                        ),
                      ),
                      validator: (v) => (v ?? '').isEmpty ? 'Enter your password' : null,
                    ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton(
                        onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => ForgotPasswordPage(phone: _identity.text.contains('@') ? '' : _identity.text))),
                        child: const Text('Forgot password?'),
                      ),
                    ),
                    if (_error != null) ...[ErrorBox(_error!), const SizedBox(height: 14)],
                    const SizedBox(height: 6),
                    BusyButton(label: 'Sign in', busy: _busy, onPressed: _submit),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Forgot password: a code by SMS to the account's phone, then a new password.
class ForgotPasswordPage extends StatefulWidget {
  const ForgotPasswordPage({super.key, this.phone = ''});
  final String phone;
  @override
  State<ForgotPasswordPage> createState() => _ForgotPasswordPageState();
}

class _ForgotPasswordPageState extends State<ForgotPasswordPage> {
  final _form = GlobalKey<FormState>();
  late final _phone = TextEditingController(text: widget.phone);
  final _code = TextEditingController();
  final _password = TextEditingController();
  final _again = TextEditingController();
  bool _sent = false;
  bool _busy = false;
  bool _hidden = true;
  String? _error;

  Future<void> _run(Future<void> Function() action) async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiError catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _sendCode() => _run(() async {
    await Api.post('/auth/otp', {'phone': normalizePhone(_phone.text), 'purpose': 'PASSWORD_RESET'}, retry: false);
    if (!mounted) return;
    setState(() => _sent = true);
    snack(context, 'We sent a 6-digit code by SMS.');
  });

  Future<void> _reset() => _run(() async {
    await Api.post('/auth/password/reset', {'phone': normalizePhone(_phone.text), 'otp': _code.text.trim(), 'password': _password.text}, retry: false);
    if (!mounted) return;
    snack(context, 'Password changed. Sign in with the new password.');
    Navigator.of(context).pop();
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Form(
            key: _form,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  _sent
                      ? 'Enter the code we sent to ${phoneText(normalizePhone(_phone.text))} and choose a new password.'
                      : 'Enter the mobile number of your merchant account. We will send a code by SMS.',
                  style: const TextStyle(color: muted),
                ),
                const SizedBox(height: 18),
                TextFormField(
                  controller: _phone,
                  enabled: !_sent,
                  keyboardType: TextInputType.phone,
                  decoration: const InputDecoration(labelText: 'Mobile number', hintText: '01XXXXXXXXX', prefixIcon: Icon(Icons.phone_iphone)),
                  validator: phoneError,
                ),
                if (_sent) ...[
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _code,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    decoration: const InputDecoration(labelText: '6-digit code', prefixIcon: Icon(Icons.sms_outlined), counterText: ''),
                    validator: (v) => RegExp(r'^\d{6}$').hasMatch(v?.trim() ?? '') ? null : 'Enter the 6-digit code',
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _password,
                    obscureText: _hidden,
                    decoration: InputDecoration(
                      labelText: 'New password',
                      helperText: 'At least 10 characters, with a letter and a number',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(icon: Icon(_hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined), onPressed: () => setState(() => _hidden = !_hidden)),
                    ),
                    validator: passwordError,
                  ),
                  const SizedBox(height: 14),
                  TextFormField(
                    controller: _again,
                    obscureText: _hidden,
                    decoration: const InputDecoration(labelText: 'New password again', prefixIcon: Icon(Icons.lock_outline)),
                    validator: (v) => v == _password.text ? null : 'The passwords do not match',
                  ),
                ],
                if (_error != null) ...[const SizedBox(height: 14), ErrorBox(_error!)],
                const SizedBox(height: 20),
                BusyButton(label: _sent ? 'Change password' : 'Send code', busy: _busy, onPressed: _sent ? _reset : _sendCode),
                if (_sent) TextButton(onPressed: _busy ? null : () => setState(() => _sent = false), child: const Text('Use another number or send the code again')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The API's password rule: 10+ characters with a letter and a digit.
String? passwordError(String? v) {
  final p = v ?? '';
  if (p.length < 10) return 'Use at least 10 characters';
  if (!RegExp(r'[A-Za-z]').hasMatch(p) || !RegExp(r'\d').hasMatch(p)) return 'Use at least one letter and one number';
  return null;
}

class BrandMark extends StatelessWidget {
  const BrandMark({super.key});
  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 46,
          height: 46,
          decoration: BoxDecoration(color: brand, borderRadius: BorderRadius.circular(12)),
          child: const Icon(Icons.local_shipping_outlined, color: Colors.white),
        ),
        const SizedBox(width: 12),
        RichText(
          text: const TextSpan(
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: ink, letterSpacing: -0.6),
            children: [
              TextSpan(text: 'delivery '),
              TextSpan(
                text: 'fast',
                style: TextStyle(color: Color(0xFFF2B705)),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
