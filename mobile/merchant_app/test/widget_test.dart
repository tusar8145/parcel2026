import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:df_core/df_core.dart';

void main() {
  testWidgets('the sign-in page checks the phone number and password before calling the server', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: LoginPage()));
    expect(find.text('Merchant sign in'), findsOneWidget);

    await tester.tap(find.text('Sign in'));
    await tester.pump();
    expect(find.text('Enter your phone number or email'), findsOneWidget);
    expect(find.text('Enter your password'), findsOneWidget);

    await tester.enterText(find.byType(TextFormField).first, '12345');
    await tester.tap(find.text('Sign in'));
    await tester.pump();
    expect(find.text('Enter a Bangladeshi mobile number (01XXXXXXXXX)'), findsOneWidget);
  });
}
