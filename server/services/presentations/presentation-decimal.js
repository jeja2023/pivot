'use strict';

function exactDecimal(number) {
    const [integer, fraction = ''] = number.replace(/^[+-]|,/g, '').split('.');
    const whole = integer.replace(/^0+(?=\d)/, '');
    const decimals = fraction.replace(/0+$/, '');
    return (number.startsWith('-') && (whole !== '0' || decimals) ? '-' : '') + whole + (decimals ? '.' + decimals : '');
}

module.exports = { exactDecimal };
