;;;; packages.lisp --- Package definitions for the sample system.

(defpackage #:payment
  (:use #:cl)
  (:nicknames #:pay)
  (:export #:transaction
           #:transaction-amount
           #:process-transaction
           #:charge-fee
           #:*fee-rate*)
  (:documentation "Core payment domain: transactions and fees."))
