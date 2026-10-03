import Capacitor
import StoreKit

@available(iOS 15.0, *)
@objc(ReceiptGoStoreKitPlugin)
public class ReceiptGoStoreKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReceiptGoStoreKitPlugin"
    public let jsName = "ReceiptGoStoreKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentEntitlements", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "manageSubscriptions", returnType: CAPPluginReturnPromise),
    ]

    private let supportedProductIds = ["com.receiptgo.pro.monthly"]
    private var updatesTask: Task<Void, Never>?

    public override func load() {
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                if case .verified(let transaction) = result,
                   self.supportedProductIds.contains(transaction.productID) {
                    self.notifyListeners("transactionUpdated", data: self.transactionPayload(transaction, signedTransaction: result.jwsRepresentation))
                }
            }
        }
    }

    deinit { updatesTask?.cancel() }

    private func transactionPayload(_ transaction: Transaction, signedTransaction: String) -> JSObject {
        [
            "transactionId": String(transaction.id),
            "productId": transaction.productID,
            "signedTransaction": signedTransaction,
        ]
    }

    private func periodText(_ period: Product.SubscriptionPeriod?) -> String? {
        guard let period else { return nil }
        let unit: String
        switch period.unit {
        case .day: unit = period.value == 1 ? "day" : "days"
        case .week: unit = period.value == 1 ? "week" : "weeks"
        case .month: unit = period.value == 1 ? "month" : "months"
        case .year: unit = period.value == 1 ? "year" : "years"
        @unknown default: return nil
        }
        return period.value == 1 ? unit : "\(period.value) \(unit)"
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                let products = try await Product.products(for: supportedProductIds)
                let payload: [JSObject] = products.map { product in
                    var item: JSObject = [
                        "id": product.id,
                        "displayName": product.displayName,
                        "description": product.description,
                        "displayPrice": product.displayPrice,
                    ]
                    if let period = periodText(product.subscription?.subscriptionPeriod) { item["period"] = period }
                    return item
                }
                call.resolve(["products": payload])
            } catch {
                call.reject("The App Store subscription could not be loaded.", "products_unavailable")
            }
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let tokenText = call.getString("appAccountToken"), let token = UUID(uuidString: tokenText) else {
            call.reject("A signed-in ReceiptGo account is required.", "invalid_account_token")
            return
        }
        Task { @MainActor in
            do {
                guard let product = try await Product.products(for: supportedProductIds).first else {
                    call.reject("ReceiptGo Pro is not available from the App Store yet.", "product_unavailable")
                    return
                }
                let result = try await product.purchase(options: [.appAccountToken(token)])
                switch result {
                case .success(let verificationResult):
                    switch verificationResult {
                    case .verified(let transaction):
                        call.resolve(["result": "verified", "transaction": transactionPayload(transaction, signedTransaction: verificationResult.jwsRepresentation)])
                    case .unverified:
                        call.reject("The App Store purchase could not be verified.", "unverified_transaction")
                    }
                case .pending:
                    call.resolve(["result": "pending"])
                case .userCancelled:
                    call.resolve(["result": "cancelled"])
                @unknown default:
                    call.reject("The App Store returned an unknown purchase result.", "unknown_purchase_result")
                }
            } catch {
                call.reject("The purchase could not be completed.", "purchase_failed")
            }
        }
    }

    private func verifiedCurrentEntitlements() async -> [JSObject] {
        var entitlements: [JSObject] = []
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result, supportedProductIds.contains(transaction.productID) {
                entitlements.append(transactionPayload(transaction, signedTransaction: result.jwsRepresentation))
            }
        }
        return entitlements
    }

    @objc func currentEntitlements(_ call: CAPPluginCall) {
        Task { @MainActor in call.resolve(["transactions": await verifiedCurrentEntitlements()]) }
    }

    @objc func restorePurchases(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                try await AppStore.sync()
                call.resolve(["transactions": await verifiedCurrentEntitlements()])
            } catch {
                call.reject("Purchases could not be restored.", "restore_failed")
            }
        }
    }

    @objc func finishTransaction(_ call: CAPPluginCall) {
        guard let transactionId = call.getString("transactionId") else {
            call.reject("A transaction ID is required.", "missing_transaction_id")
            return
        }
        Task { @MainActor in
            for await result in Transaction.all {
                if case .verified(let transaction) = result, String(transaction.id) == transactionId {
                    await transaction.finish()
                    call.resolve()
                    return
                }
            }
            call.reject("The verified transaction was not found.", "transaction_not_found")
        }
    }

    @objc func manageSubscriptions(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else {
                call.reject("Subscription settings are unavailable.", "window_unavailable")
                return
            }
            do {
                try await AppStore.showManageSubscriptions(in: scene)
                call.resolve()
            } catch {
                call.reject("Subscription settings could not be opened.", "manage_failed")
            }
        }
    }
}
