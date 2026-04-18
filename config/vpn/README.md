# Windscribe OpenVPN Configuration Files

Place your Windscribe `.ovpn` configuration files in **this directory**.
The control panel will automatically list them in the endpoint dropdown.

---

## How to get your Windscribe .ovpn files

1. Log in at **https://windscribe.com**
2. Go to **My Account → OpenVPN Config Generator**
   (direct link: https://windscribe.com/getconfig/openvpn)
3. Select:
   - **Protocol**: UDP (recommended) or TCP
   - **Port**: 443
   - **Location**: Italy (or any location with the city / label you want)
   - **Credentials**: Include in file *(optional – the proxy uses the user/pass you enter in the UI)*
4. Download the `.ovpn` file and copy it here.

## Naming convention

The filename (without `.ovpn`) becomes the endpoint label in the UI.
Use hyphens or underscores as word separators – they are auto-converted to spaces and title-cased:

| File                    | Label shown in UI       |
|-------------------------|-------------------------|
| `milan-duomo.ovpn`      | Milan Duomo             |
| `milan-galleria.ovpn`   | Milan Galleria          |
| `rome-colosseo.ovpn`    | Rome Colosseo           |
| `venice-rialto.ovpn`    | Venice Rialto           |
| `italy-generic.ovpn`    | Italy Generic           |

## Example minimal .ovpn template

```text
client
dev tun
proto udp
remote <server-hostname> 443
resolv-retry infinite
nobind
persist-key
persist-tun
tls-client
remote-cert-tls server
auth SHA512
cipher AES-256-CBC
compress lz4
verb 3
<ca>
# Paste the Windscribe CA certificate here (from your downloaded .ovpn file)
-----BEGIN CERTIFICATE-----
...
-----END CERTIFICATE-----
</ca>
```

> **Tip**: Do NOT put the `auth-user-pass` directive in the file –
> credentials are injected securely at runtime by the proxy application.
