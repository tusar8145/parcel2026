import 'package:flutter_test/flutter_test.dart';
import 'package:merchant_app/api.dart';

void main() {
  test('money is shown in taka with thousands separators', () {
    expect(taka(1250), '৳1,250');
    expect(taka(3887.5), '৳3,887.50');
    expect(taka(-40), '-৳40');
    expect(taka(null), '৳0');
  });

  test('phone numbers are taken in every accepted form and shown locally', () {
    expect(normalizePhone('1711 000000'), '01711000000');
    expect(normalizePhone('01711-000000'), '01711000000');
    expect(isBdMobile('+8801711000000'), isTrue);
    expect(isBdMobile('12345'), isFalse);
    expect(phoneText('+8801911000301'), '01911-000301');
  });
}
