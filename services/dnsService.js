// /services/dnsService.js

const dns = require('dns').promises;
const url = require('url');

const REQUIRED_NAMESERVERS = ['ns1.hostaero.top', 'ns2.hostaero.top'];

/**
 * Extracts the main domain from a hostname.
 * e.g., 'test.wamosync.in' becomes 'wamosync.in'
 * e.g., 'www.google.com' becomes 'google.com'
 * @param {string} hostname The full hostname from a URL.
 * @returns {string} The main domain.
 */
function getMainDomain(hostname) {
    // This is a simple but effective method for most common domains.
    // It splits the hostname by dots and takes the last two parts.
    const parts = hostname.split('.');
    if (parts.length > 2) {
        // Handles subdomains like 'test.wamosync.in'
        return parts.slice(-2).join('.');
    }
    // Handles main domains like 'wamosync.in'
    return hostname;
}

/**
 * Checks if a given website URL is using the required nameservers.
 * This version is now smart enough to handle subdomains correctly.
 * @param {string} websiteUrl The full URL of the website to check.
 * @returns {Promise<{isVerified: boolean, message: string}>}
 */
async function checkNameservers(websiteUrl) {
    try {
        const parsedUrl = new url.URL(websiteUrl);
        const hostname = parsedUrl.hostname; // e.g., 'test.wamosync.in'

        if (!hostname) {
            return { isVerified: false, message: 'Invalid URL provided.' };
        }

        // --- THIS IS THE NEW, SMARTER LOGIC ---
        const mainDomain = getMainDomain(hostname); // e.g., 'wamosync.in'
        console.log(`Checking NS records for main domain: ${mainDomain}`);

        // Perform the DNS lookup on the main domain, not the full hostname
        const nameservers = await dns.resolveNs(mainDomain);

        const hasNs1 = nameservers.some(ns => ns.toLowerCase() === REQUIRED_NAMESERVERS[0]);
        const hasNs2 = nameservers.some(ns => ns.toLowerCase() === REQUIRED_NAMESERVERS[1]);

        if (hasNs1 && hasNs2) {
            return { isVerified: true, message: `Correct nameservers found for ${mainDomain}: ${nameservers.join(', ')}` };
        } else {
            return { isVerified: false, message: `Required nameservers not found for ${mainDomain}. Found: ${nameservers.join(', ')}` };
        }

    } catch (error) {
        console.error(`DNS check failed for ${websiteUrl}:`, error.message);
        return { isVerified: false, message: 'Could not resolve nameservers for the main domain. It may not exist.' };
    }
}

module.exports = { checkNameservers };